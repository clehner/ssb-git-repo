var ref = require('ssb-ref')
var pull = require('pull-stream')
var multicb = require('multicb')
var crypto = require('crypto')

module.exports = GitSSBRepo

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

function GitSSBRepo(sbot, feed, name) {
  if (!(this instanceof GitSSBRepo))
    return new GitSSBRepo(sbot, feed, name)

  if (!ref.isFeed(feed))
    throw new Error('Invalid feed ID: ' + feed)

  this.sbot = sbot
  this.feed = feed
  this.name = name
  this._refs = {/* ref: sha1 */}
  this._objects = {/* sha1: {type, length, key} */}

  pull(
    sbot.createHistoryStream({id: feed, live: true}),
    pull.drain(this._processMsg.bind(this))
  )
}

GitSSBRepo.prototype._processMsg = function (msg) {
  var c = msg.value.content
  if (c.type == 'git-update' && c.repo == this.name) {
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
}

GitSSBRepo.prototype._getBlob = function (hash, cb) {
  var blobs = this.sbot.blobs
  blobs.want(hash, function (err, got) {
    if (err) cb(err)
    else if (!got) cb(new Error('Unable to get blob ' + hash))
    else cb(null, blobs.get(hash))
  })
}

GitSSBRepo.prototype._hashLookup = function (sha1, cb) {
  cb(null, this._objects[sha1])
}

// get refs source({name, hash})
GitSSBRepo.prototype.refs = function (prefix) {
  if (prefix) throw new Error('prefix not supported')
  var refs = this._refs
  var ended
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

GitSSBRepo.prototype.hasObject = function (hash, cb) {
  var blobs = this.sbot.blobs
  this._hashLookup(hash, function (err, obj) {
    cb(err, !!obj)
  })
}

GitSSBRepo.prototype.getObject = function (hash, cb) {
  var blobs = this.sbot.blobs
  this._hashLookup(hash, function (err, obj) {
    cb(err, obj && {
      type: obj.type,
      length: obj.length,
      read: blobs.get(obj.key)
    })
  })
}

GitSSBRepo.prototype.update = function (readRefUpdates, readObjects, cb) {
  var done = multicb({pluck: 1})
  var sbot = this.sbot
  var ended
  var msg = {
    type: 'git-update',
    repo: this.name
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
          console.error('git hash', sha1)
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
