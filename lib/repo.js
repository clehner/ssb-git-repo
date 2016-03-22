var pull = require('pull-stream')
var multicb = require('multicb')
var crypto = require('crypto')
var cat = require('pull-cat')
var cache = require('pull-cache')
var reverse = require('pull-reverse')
var pushable = require('pull-pushable')
var ref = require('ssb-ref')
var createGitHash = require('pull-hash/ext/git')
var createSSBBlobHash = require('pull-hash/ext/ssb')

module.exports = Repo

function addSSBBlob(sbot, cb) {
  // work around sbot.blobs.add not calling back with blob id
  var done = multicb({ pluck: 1, spread: true })
  var hashCb = done()
  done(cb)
  return pull(createSSBBlobHash(hashCb), sbot.blobs.add(done()))
}

function Repo(sbot, id, msg) {
  this.sbot = sbot
  this.id = id
  this.feed = msg.author
  this._refs = {/* ref: sha1 */}
  this._objects = {/* sha1: {type, length, key} */}
  this._blobs = {/* sha1: [Buffer] */}

  // queued operations while syncing of old messages
  this._oldRefPushables = []
  this._hashLookups = {/* sha1: [cb(err, object)] */}
  this._headCbs = []

  this._oldPacksPushable = pushable()
  this._newPacksPushable = pushable()
  this._oldPacks = cache(this._oldPacksPushable)
  this._newPacks = reverse(this._newPacksPushable)
}

Repo.prototype.closed = false
Repo.prototype.synced = false
Repo.prototype.syncedRefs = false

Repo.prototype.close = function (cb) {
  if (this.closed) return
  this.closed = true
  if (this._readNew)
    this._readNew(true, cb || function () {})
}

Repo.prototype._setHead = function (head) {
  this.head = head
  while (this._headCbs.length)
    this._headCbs.shift()(null, head)
}

Repo.prototype._processOldMsg = function (c) {
  if (c.head && !this.head)
    this._setHead(c.head)

  for (var ref in c.refs || {}) {
    if (!(ref in this._refs)) {
      var hash = c.refs[ref]
      this._refs[ref] = hash
      if (hash) {
        var refObj = {name: ref, hash: hash}
        this._oldRefPushables.forEach(function (pushable) {
          pushable.push(refObj)
        })
      }
    }
  }

  if (Array.isArray(c.objects)) {
    for (var i = 0; i < c.objects.length; i++) {
      var obj = c.objects[i]
      var sha1 = obj && obj.sha1
      if (!sha1) continue
      if (!(sha1 in this._objects)) {
        // complete waiting lookups
        this._addObject(sha1, obj)
      }
    }
  } else if (c.objects) {
    // old format
    for (var sha1 in c.objects) {
      if (!(sha1 in this._objects)) {
        var obj = c.objects[sha1]
        this._addObject(sha1, obj)
      }
    }
  }

  if (c.packs) for (var i = 0; i < c.packs.length; i++) {
    if (c.packs[i].link) {
      // new way
      this._oldPacksPushable.push({
        packId: c.packs[i].link,
        idxId: ((c.indexes || [])[i] || {}).link,
      })
    } else {
      // old way, ssb-git-repo <= 1.3.0
      this._oldPacksPushable.push({
        packId: c.packs[i].pack.link,
        idxId: c.packs[i].idx.link,
      })
    }
  }
}

Repo.prototype._processNewMsg = function (c) {
  if (c.head)
    this._setHead(c.head)

  for (var name in c.refs || {})
    if (c.refs[name])
      this._refs[name] = c.refs[name]
    else
      delete this._refs[name]

  if (Array.isArray(c.objects)) {
    for (var i = 0; i < c.objects.length; i++) {
      var obj = c.objects[i]
      var sha1 = obj && obj.sha1
      if (!sha1) continue
      this._addObject(sha1, obj)
    }
  } else if (c.objects) {
    // old format
    for (var sha1 in c.objects)
      this._objects[sha1] = c.objects[sha1]
  }

  if (c.packs) for (var i = 0; i < c.packs.length; i++) {
    if (c.packs[i].link) {
      // new way
      this._newPacksPushable.push({
        packId: c.packs[i].link,
        idxId: ((c.indexes || [])[i] || {}).link,
      })
    } else {
      // new way, ssb-git-repo <= 1.3.0
      this._oldPacksPushable.push({
        packId: c.packs[i].pack.link,
        idxId: c.packs[i].idx.link,
      })
    }
  }
}

Repo.prototype._getBlob = function (key, cb) {
  if (!key) return cb(new Error('Missing blob key'))
  var blobs = this.sbot.blobs
  blobs.want(key, function (err, got) {
    if (err) cb(err)
    else if (!got) cb(new Error('Unable to get blob ' + key))
    else cb(null, blobs.get(key))
  })
}

Repo.prototype._getBlobCached = function (key, cb) {
  var blobs = this._blobs
  if (key in blobs)
    cb(null, pull.values(blobs[key]))
  else
    this._getBlob(key, function (err, read) {
      pull(read, pull.collect(function (err, bufs) {
        if (err) return cb(err)
        blobs[key] = bufs
        cb(null, pull.values(bufs))
      }))
    })
}

Repo.prototype._hashLookup = function hashLookup(sha1, cb) {
  if (this.synced || sha1 in this._objects)
    cb(null, this._objects[sha1])
  else if (sha1 in this._hashLookups)
    this._hashLookups[sha1].push(cb)
  else
    this._hashLookups[sha1] = [cb]
}

// get refs source({name, hash})
Repo.prototype.refs = function () {
  return this.syncedRefs
    ? this._currentRefs()
    : cat([
      this._currentRefs(),
      this._oldRefs()
    ])
}

Repo.prototype.symrefs = function () {
  var ended
  if (this.head)
    return pull.once({name: 'HEAD', ref: this.head})
  else if (!this.synced)
    return function (end, cb) {
      if (ended || end) return cb(ended || end)
      this._headCbs.push(function (err, ref) {
        ended = err || true
        cb(err, {name: 'HEAD', ref: ref})
      })
    }.bind(this)
  else
    return pull.empty()
}

Repo.prototype._currentRefs = function () {
  var refs = this._refs
  return pull(
    pull.values(Object.keys(refs)),
    pull.map(function (name) {
      return {
        name: name,
        hash: refs[name]
      }
    }),
    pull.filter(function (ref) {
      return ref.hash
    })
  )
}

// get refs that are being read from history
Repo.prototype._oldRefs = function () {
  var read = pushable()
  this._oldRefPushables.push(read)
  return read
}

Repo.prototype._addObject = function (sha1, object) {
  this._objects[sha1] = object
  // notify listeners waiting for the object
  var cbs = this._hashLookups[sha1]
  if (cbs) {
    while (cbs.length)
      cbs.shift()(null, object)
    delete this._hashLookups[sha1]
  }
}

Repo.prototype._sync = function (live) {
  if (live)
    now = [Date.now()]

  pull(
    this.sbot.links({
      type: 'git-update',
      dest: this.id,
      source: this.feed,
      rel: 'repo',
      values: true,
      keys: false,
      reverse: true
    }),
    pull.map(function (msg) {
      return msg.value.content
    }),
    pull.drain(this._processOldMsg.bind(this), function (err) {
      this._oldPacksPushable.end(err)

      this._oldRefPushables.forEach(function (pushable) {
        pushable.end(err)
      })
      delete this._oldRefPushables
      this.syncedRefs = true

      // pick a head from the current branches if head was not set
      var head = this.head
      var defaultHead = 'refs/heads/master'
      if (!head) {
        if (defaultHead in this._refs)
          head = defaultHead
        else
          for (head in this._refs) break
        this._setHead(head)
      }

      // complete waiting requests for lookups
      this.synced = true
      for (var sha1 in this._hashLookups)
        this._addObject(sha1, null)

      if (live)
        this._syncNew(now)
    }.bind(this))
  )
}

Repo.prototype._syncNew = function (since) {
  if (this.closed) return
  var id = this.id
  pull(
    this._readNew = this.sbot.createHistoryStream({
      id: this.feed,
      live: true,
      gt: since
    }),
    pull.map(function (msg) {
      return msg.value.content
    }),
    pull.filter(function (c) {
      return (c.type == 'git-update' && c.repo == id)
    }),
    pull.drain(this._processNewMsg.bind(this), function (err) {
      if (err) throw err
    })
  )
}

Repo.prototype.hasObject = function (hash, cb) {
  var blobs = this.sbot.blobs
  this._hashLookup(hash, function (err, obj) {
    cb(err, !!obj)
  })
}

Repo.prototype.getObject = function (hash, cb) {
  this._hashLookup(hash, function (err, obj) {
    if (err) return cb(err)
    if (!obj) return cb(new Error('Object not present with hash ' + hash))
    var blobId = obj.link || obj.key
    if (!blobId) return cb(new Error('Object is missing blob key'))
    if (obj.type == 'blob')
      this._getBlob(blobId, gotData)
    else
      this._getBlobCached(blobId, gotData)
    function gotData(err, read) {
      if (err) return cb(err)
      cb(null, {
        type: obj.type,
        length: obj.length,
        read: read
      })
    }
  }.bind(this))
}

Repo.prototype.getPackfile = function (id, cb) {
  this._getBlob(id, cb)
}

Repo.prototype.getPackIndex = function (id, cb) {
  this._getBlob(id, cb)
}

Repo.prototype.packs = function () {
  return cat([
    this._newPacks(),
    this._oldPacks()
  ])
}

Repo_readRefUpdates = function (updates, cb) {
  var oldRefs = this._refs
  var refs
  var ended
  updates(null, function next(end, update) {
    if (ended = end) return cb(end === true ? null : end, refs)
    if (update.old != oldRefs[update.name])
      return cb(new Error(
        'Ref update old value is incorrect. ' +
        'ref: ' + update.name + ', ' +
        'old in update: ' + update.old + ', ' +
        'old in repo: ' + oldRefs[update.name]
      ))
    ;(refs || (refs = {}))[update.name] = update.new
    if (!ended)
      updates(null, next)
  })
}

Repo.prototype.update = function (readRefUpdates, readObjects, cb) {
  if (this.sbot.id && this.sbot.id != this.feed)
    return cb(new Error('You do not have permission to push to this repo'))
  var done = multicb({ pluck: 1, spread: true })
  var sbot = this.sbot
  var allObjects = this._objects
  var objects = []
  var ended
  var msg = {
    type: 'git-update',
    repo: this.id
  }

  if (readRefUpdates)
    Repo_readRefUpdates.call(this, readRefUpdates, done())

  if (readObjects) {
    var doneReadingObjects = done()
    readObjects(null, function next(end, object) {
      if (end) return doneReadingObjects(end === true ? null : end)
      var sha1, blobHash
      var hashDone = multicb({pluck: 1, spread: true})
      pull(
        object.read,
        createGitHash(object, hashDone()),
        addSSBBlob(sbot, hashDone())
      )
      hashDone(function (err, gitHash, blobKey) {
        if (err) return doneReadingObjects(err)
        var sha1 = gitHash.toString('hex')
        objects.push(allObjects[sha1] = {
          type: object.type,
          length: object.length,
          link: blobKey,
          sha1: sha1
        })
        if (!ended)
          readObjects(null, next)
      })
    })
  }

  var self = this
  done(function (err, refUpdatesObj) {
    ended = true
    if (err) return cb(err)
    if (!objects.length && !refUpdatesObj)
      return cb()

    msg.objects = objects
    msg.refs = refUpdatesObj
    sbot.publish(msg, function (err, msgPublished) {
      if (err) {
        if (/must not be large/.test(err.message)) {
          // max msg size is 8192 bytes.
          // TODO: do something better here
          cb(new Error('Update is too big to send! ' +
            'Try pushing fewer commits.\n\n' +
            'Message size: ' + JSON.stringify(msg).length + ', ' +
            'max size: 8192'))
        } else {
          cb(err)
        }
      } else {
        self._processNewMsg(msgPublished.value.content)
        setTimeout(cb, 10)
      }
    })
  })
}

Repo.prototype.uploadPack = function (readRefUpdates, readPacks, cb) {
  if (this.sbot.id && this.sbot.id != this.feed)
    return cb(new Error('You do not have permission to push to this repo'))
  var self = this
  var done = multicb({ pluck: 1, spread: true })
  var packsCb = done()
  var indexesCb = done()

  pull(
    readPacks,
    pull.asyncMap(function (pack, cb) {
      var done = multicb({ pluck: 1, spread: true })
      pull(pack.pack, addSSBBlob(self.sbot, done()))
      pull(pack.idx, addSSBBlob(self.sbot, done()))
      done(function (err, packId, idxId) {
        cb(err, {pack: {link: packId}, idx: {link: idxId}})
      })
    }),
    pull.collect(function (err, combined) {
      packsCb(err, combined.map(function (obj) { return obj.pack }))
      indexesCb(err, combined.map(function (obj) { return obj.idx }))
    })
  )

  if (readRefUpdates)
    Repo_readRefUpdates.call(this, readRefUpdates, done())

  done(function (err, packs, indexes, refUpdatesObj) {
    if (err) return cb(err)
    self.sbot.publish({
      type: 'git-update',
      repo: self.id,
      packs: packs,
      indexes: indexes,
      refs: refUpdatesObj
    }, function (err, msg) {
      if (err) return cb(err)
      self._processNewMsg(msg.value.content)
      setTimeout(cb, 10)
    })
  })
}
