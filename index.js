var ref = require('ssb-ref')
var pull = require('pull-stream')
var multicb = require('multicb')
var crypto = require('crypto')

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
    cb(err, msg && new Repo(sbot, msg.key))
  })
}

exports.getRepo = function (sbot, id, cb) {
  sbot.get(id, function (err, msg) {
    if (err) return cb(err)
    cb(null, new Repo(sbot, id, author))
  })
}

function Repo(sbot, msgId, feedId) {
  if (!ref.isMsg(msgId))
    throw new Error('Invalid repo ID: ' + id)

  this.sbot = sbot
  this.id = msgId
  this.feed = feedId
  this._refs = {/* ref: sha1 */}
  this._objects = {/* sha1: {type, length, key} */}
}

exports.Repo = Repo

Repo.prototype.closed = false

Repo.prototype.close = function (cb) {
  if (this.closed) return
  this.closed = true
  this._stream(true, cb)
}

Repo.prototype._sync = function () {
  /*
  var seq = 0

  pull(
    sbot.createHistoryStream({id: feed}),
    pull.drain(function (msg) {
      console.error('msg', msg)
      seq = msg.seq
      repo._processMsg(msg)
    }, function (err) {
      if (err) return cb(err)
      pull(
        repo._stream =
          sbot.createHistoryStream({id: feed, seq: seq, live: true}),
        pull.drain(repo._processMsg.bind(repo))
      )
      cb(null, repo)
    })
  )
  */
}

Repo.prototype._processMsg = function (msg) {
  var c = msg.value.content
  if (c.type != 'git-update' || c.repo != this.id) return
  var update = c.refs
  if (update) {
    var refs = this._refs
    for (var name in update) {
      if (update[name])
        refs[name] = update[name]
      else
        delete refs[name]
    }
  }

  var objects = c.objects
  if (objects) {
    var allObjects = this._objects
    for (var sha1 in objects) {
      allObjects[sha1] = objects[sha1]
    }
  }
}

Repo.prototype._getBlob = function (key, cb) {
  var blobs = this.sbot.blobs
  blobs.want(key, function (err, got) {
    if (err) cb(err)
    else if (!got) cb(new Error('Unable to get blob ' + key))
    else cb(null, blobs.get(key))
  })
}

Repo.prototype._hashLookup = function (sha1, cb) {
  cb(null, this._objects[sha1])
}

// get refs source({name, hash})
Repo.prototype.refs = function (prefix) {
  if (prefix) throw new Error('prefix not supported')
  // var refs = this._refs
  var refs = {}
  return pull(
    this.sbot.links({
      type: 'git-update',
      dest: this.id,
      source: this.feed,
      rel: 'repo',
      values: true,
      reverse: true
    }),
    pull.map(function (msg) {
      var c = msg.value.content
      var refsArr = []
      if (c.refs)
        for (var ref in c.refs)
          if (!(ref in refs)) {
            var hash = c.refs[ref]
            refs[ref] = hash
            if (hash)
              refsArr.push({name: ref, hash: hash})
          }
      return refsArr
    }),
    pull.flatten()
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
    if (!obj) return cb()
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
      var sha1
      pull(
        object.read,
        createGitHash(object, function (err, hash) {
          if (err) return doneReadingObjects(err)
          sha1 = hash.toString('hex')
        }),
        sbot.blobs.add(function (err, hash) {
          if (err) return doneReadingObjects(err)
          objects[sha1] = {
            type: object.type,
            length: object.length,
            key: hash
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
      self._processMsg(msg)
      cb()
    })
  })
}
