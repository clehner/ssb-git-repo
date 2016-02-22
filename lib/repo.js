var pull = require('pull-stream')
var multicb = require('multicb')
var crypto = require('crypto')
var cat = require('pull-cat')
var pushable = require('pull-pushable')
var ref = require('ssb-ref')

module.exports = Repo

function createHash(type, onEnd) {
  var hash = (typeof type == 'string') ? crypto.createHash(type) : type
  var digest
  var ended
  function hasher(read) {
    return function (abort, cb) {
      read(abort, function (end, data) {
        if (end === true && !digest) digest = hash.digest()
        else if (!end) hash.update(data)
        cb(end, data)
        if (end && onEnd && !ended) {
          onEnd(end === true ? null : end, digest)
          ended = true
        }
      })
    }
  }
  hasher.hash = hash
  return hasher
}

function createGitHash(object, onEnd) {
  var hasher = createHash('sha1', onEnd)
  hasher.hash.update(object.type + ' ' + object.length + '\0')
  return hasher
}

function createSSBBlobHash(onEnd) {
  return createHash('sha256', function (err, digest) {
    onEnd(err, digest && ('&' + digest.toString('base64') + '.sha256'))
  })
}

function objectsArrayToMap(arr) {
  var o = {}
  for (var i = 0; i < arr.length; i++) {
    var obj = arr[i]
    o[obj.sha1] = {
      type: obj.type,
      length: obj.length,
      key: obj.key
    }
  }
  return o
}

function Repo(sbot, id, msg) {
  this.sbot = sbot
  this.id = id
  this.feed = msg.author
  this._refs = {/* ref: sha1 */}
  this._objects = {/* sha1: {type, length, key} */}
  this._externalBlobsRead = {/* blobId */}

  // queued operations while syncing of old messages
  this._oldRefPushables = []
  this._hashLookups = {/* sha1: [cb(err, object)] */}
  this._headCbs = []
  this._hashLookupsMulticb = multicb()
}

Repo.prototype.closed = false
Repo.prototype.synced = false

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

  for (var sha1 in c.objects || {}) {
    if (!(sha1 in this._objects)) {
      var obj = c.objects[sha1]
      this._objects[sha1] = obj

      // complete waiting lookups
      this._addObject(sha1, obj)
    }
  }

  if (c.objects_ext)
    this._readExternalObjects(c.objects_ext)
}

Repo.prototype._processNewMsg = function (c) {
  if (c.head)
    this._setHead(c.head)

  for (var name in c.refs || {})
    if (c.refs[name])
      this._refs[name] = c.refs[name]
    else
      delete this._refs[name]

  for (var sha1 in c.objects || {})
    this._objects[sha1] = c.objects[sha1]

  if (c.objects_ext)
    this._readExternalObjects(c.objects_ext)
}

// read index of git SHA1 -> object info from a blob
Repo.prototype._readExternalObjects = function (blobId) {
  if (!ref.isBlobId(blobId)) return
  if (blobId in this._externalBlobsRead)
    return console.error('skip ext', blobId)
  this._externalBlobsRead[blobId] = true
  var cb = this._hashLookupsMulticb()
  var self = this
  this._getBlob(blobId, function (err, read) {
    if (err) return cb()
    pull(
      read,
      pull.collect(function (err, bufs) {
        if (err) return cb()
        var objects
        try {
          objects = JSON.parse(Buffer.concat(bufs))
        } catch(e) {}
        if (objects)
          for (var sha1 in objects)
            self._addObject(sha1, objects[sha1])
        cb()
      })
    )
  })
}

Repo.prototype._getBlob = function (key, cb) {
  var blobs = this.sbot.blobs
  blobs.want(key, function (err, got) {
    if (err) cb(err)
    else if (!got) cb(new Error('Unable to get blob ' + key))
    else cb(null, blobs.get(key))
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
  return this.synced
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
  var hashLookups = this._hashLookupsMulticb()

  this._hashLookupsMulticb(function () {
    this.synced = true
    // complete waiting requests for lookups
    for (var sha1 in this._hashLookups)
      this._addObject(sha1, null)
  }.bind(this))

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
      this._oldRefPushables.forEach(function (pushable) {
        pushable.end(err)
      })
      delete this._oldRefPushables

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

      // done looking up hashes from messages. now wait for objects_ext blobs
      hashLookups()

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
    this._getBlob(obj.key, function (err, read) {
      if (err) return cb(err)
      cb(null, {
        type: obj.type,
        length: obj.length,
        read: read
      })
    })
  }.bind(this))
}

Repo.prototype.update = function (readRefUpdates, readObjects, cb) {
  var done = multicb({pluck: 1})
  var sbot = this.sbot
  var allObjects = this._objects
  var maxObjects = 400
  var objects = []
  var ended
  var msg = {
    type: 'git-update',
    repo: this.id
  }
  var gotRefUpdates

  if (readRefUpdates) {
    var doneReadingRefs = done()
    var oldRefs = this._refs
    var refs = msg.refs = {}
    readRefUpdates(null, function next(end, update) {
      if (end) return doneReadingRefs(end === true ? null : end)
      if (update.old != oldRefs[update.name])
        return doneReadingRefs(new Error(
          'Ref update old value is incorrect. ' +
          'ref: ' + update.name + ', ' +
          'old in update: ' + update.old + ', ' +
          'old in repo: ' + oldRefs[update.name]
        ))
      refs[update.name] = update.new
      gotRefUpdates = true
      if (!ended)
        readRefUpdates(null, next)
    })
  }

  if (readObjects) {
    var doneReadingObjects = done()
    readObjects(null, function next(end, object) {
      if (end) return doneReadingObjects(end === true ? null : end)
      var sha1, blobHash
      var hashDone = multicb({pluck: 1, spread: true})
      pull(
        object.read,
        createGitHash(object, hashDone()),
        createSSBBlobHash(hashDone()),
        sbot.blobs.add(hashDone())
      )
      hashDone(function (err, gitHash, blobKey) {
        if (err) return doneReadingObjects(err)
        var sha1 = gitHash.toString('hex')
        objects.push(allObjects[sha1] = {
          type: object.type,
          length: object.length,
          key: blobKey,
          sha1: sha1 // this gets removed by objectsArrayToMap before publish
        })
        if (!ended)
          readObjects(null, next)
      })
    })
  }

  var self = this
  done(function (err) {
    ended = true
    if (err) return cb(err)
    if (!objects.length && !gotRefUpdates)
      return cb()

    // max msg size is 8192 bytes.
    // when the objects list is too big to fit,
    // put it in a blob and link to that.
    if (objects.length > maxObjects) {
      tryPublish()
    } else {
      msg.objects = objectsArrayToMap(objects)
      next()
    }
  })

  function tryPublish() {
    // console.error('trying', maxObjects, new Date())

    // move objects from the message into the external blob
    // until the message is small enough to publish.
    // TODO: put high-priority objects in the message first,
    // e.g. branch heads and root trees and readmes
    msg.objects = objectsArrayToMap(objects.slice(0, maxObjects))
    var objsExt = objectsArrayToMap(objects.slice(maxObjects))

    var hashDone = multicb({pluck: 1, spread: true})
    pull(
      pull.once(JSON.stringify(objsExt)),
      createSSBBlobHash(hashDone()),
      sbot.blobs.add(hashDone())
    )
    hashDone(function (err, blobKey) {
      if (err) return cb(err)
      msg.objects_ext = blobKey
      next()
    })
  }

  function next() {
    sbot.publish(msg, function (err, msg) {
      if (err) {
        if (/must not be large/.test(err.message)) {
          if (maxObjects <= 1) {
            cb(new Error('Message is too big to send'))
          } else {
            maxObjects >>= 1
            tryPublish()
          }
        } else {
          cb(err)
        }
      } else {
        self._processNewMsg(msg.value.content)
        setTimeout(cb, 10)
      }
    })
  }
}
