var ref = require('ssb-ref')
var pull = require('pull-stream')
var multicb = require('multicb')
var crypto = require('crypto')
var cat = require('pull-cat')
var pushable = require('pull-pushable')

function createHash(type, onEnd) {
  var hash = (typeof type == 'string') ? crypto.createHash(type) : type
  function hasher(read) {
    return function (abort, cb) {
      read(abort, function (end, data) {
        var digest
        if (end === true) digest = hash.digest()
        else if (!end) hash.update(data)
        cb(end, data)
        if (end && onEnd) onEnd(end === true ? null : end, digest)
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

exports.createRepo = function (sbot, options, cb) {
  if (typeof options == 'function') cb = options, options = null
  var msg = {
    type: 'git-repo'
  }
  if (options) {
    if (options.forks && !ref.isMsg(options.forks))
      throw new Error('Invalid repo ID: ' + options.forks)
    for (var key in options)
      msg[key] = options[key]
  }
  sbot.publish(msg, function (err, msg) {
    var repo = new Repo(sbot, msg.key, msg.value)
    repo.synced = true
    cb(err, msg && repo)
  })
}

exports.getRepo = function (sbot, id, cb) {
  sbot.get(id, function (err, msg) {
    if (err) return cb(err)
    var repo = new Repo(sbot, id, msg)
    repo._sync()
    cb(null, repo)
  })
}

function Repo(sbot, id, msg, isNew) {
  this.sbot = sbot
  this.id = id
  this.feed = msg.author
  this._refs = {/* ref: sha1 */}
  this._objects = {/* sha1: {type, length, key} */}

  // queued operations while syncing of old messages
  this._oldRefPushables = []
  this._hashLookups = {/* sha1: cb(err, object) */}
}

exports.Repo = Repo

Repo.prototype.closed = false
Repo.prototype.synced = false

Repo.prototype.close = function (cb) {
  if (this.closed) return
  this.closed = true
  if (this._readNew)
    this._readNew(true, cb)
}

Repo.prototype._processOldMsg = function (c) {
  for (var ref in c.refs || {}) {
    if (!(ref in this._refs)) {
      var hash = c.refs[ref]
      this._refs[ref] = hash
      var refObj = {name: ref, hash: hash}
      this._oldRefPushables.forEach(function (pushable) {
        pushable.push(refObj)
      })
    }
  }

  for (var sha1 in c.objects || {}) {
    if (!(sha1 in this._objects)) {
      var obj = c.objects[sha1]
      this._objects[sha1] = obj

      // complete waiting lookup
      if (sha1 in this._hashLookups) {
        this._hashLookups[sha1](null, obj)
        delete this._hashLookups[sha1]
      }
    }
  }
}

Repo.prototype._processNewMsg = function (c) {
  for (var name in c.refs || {})
    if (c.refs[name])
      this._refs[name] = c.refs[name]
    else
      delete this._refs[name]

  for (var sha1 in c.objects || {})
    this._objects[sha1] = c.objects[sha1]
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
  else
    this._hashLookups[sha1] = cb
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

Repo.prototype._currentRefs = function () {
  var refs = this._refs
  return pull(
    pull.values(Object.keys(refs)),
    pull.map(function (name) {
      return {
        name: name,
        hash: refs[name]
      }
    })
  )
}

// get refs that are being read from history
Repo.prototype._oldRefs = function () {
  var read = pushable()
  this._oldRefPushables.push(read)
  return read
}

Repo.prototype._sync = function () {
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
      this.synced = true
      this._oldRefPushables.forEach(function (pushable) {
        pushable.end(err)
      })
      delete this._oldRefPushables

      // complete waiting requests for lookups
      for (var sha1 in this._hashLookups) {
        this._hashLookups[sha1](null, null)
      }
      delete this._hashLookups

      this._syncNew([Date.now()])
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
  var ended
  var msg = {
    type: 'git-update',
    repo: this.id
  }

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
      if (!ended)
        readRefUpdates(null, next)
    })
  }

  if (readObjects) {
    var doneReadingObjects = done()
    var objects = msg.objects = {}
    readObjects(null, function next(end, object) {
      if (end) return doneReadingObjects(end === true ? null : end)
      var sha1, blobHash
      pull(
        object.read,
        createGitHash(object, function (err, hash) {
          if (err) return doneReadingObjects(err)
          sha1 = hash.toString('hex')
        }),
        createSSBBlobHash(function (err, hash) {
          if (err) return doneReadingObjects(err)
          blobHash = hash
        }),
        sbot.blobs.add(function (err) {
          if (err) return doneReadingObjects(err)
          objects[sha1] = {
            type: object.type,
            length: object.length,
            key: blobHash
          }
          if (!ended)
            readObjects(null, next)
        })
      )
    })
  }

  var self = this
  done(function (err) {
    ended = true
    if (err) return cb(err)
    sbot.publish(msg, function (err, msg) {
      if (err) return cb(err)
      // pre-emptively apply the local update.
      // the update is idempotent so this is ok.
      self._processNewMsg(msg.value.content)
      setTimeout(cb, 10)
    })
  })
}
