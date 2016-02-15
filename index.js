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
}

// FIXME
var cache = {}

GitSSBRepo.prototype._getBlob = function (hash, cb) {
  var blobs = this.sbot.blobs
  blobs.want(hash, function (err, got) {
    if (err) cb(err)
    else if (!got) cb(new Error('Unable to get blob ' + hash))
    else cb(null, blobs.get(hash))
  })
}

GitSSBRepo.prototype._hashLookup = function (sha1, cb) {
  cb(null, cache[sha1])
  // cb(new Error('not implemented'))
}

// get refs source({name, hash})
GitSSBRepo.prototype.refs = function (prefix) {
  if (prefix) throw new Error('prefix not supported')
  var ended, refs
  return function read(end, cb) {
    if (ended) return
    if (!refs)
      return this.getRefs(function (err, _refs) {
        if (ended = err) return cb(err)
        refs = _refs
        read(end, cb)
      })
    for (var name in refs) {
      var hash = refs[name]
      delete refs[name]
      cb(null, {name: name, hash: hash})
      return
    }
    cb(ended = true)
  }.bind(this)
}

// get refs object {name: hash}
GitSSBRepo.prototype.getRefs = function (cb) {
  var refs = {}
  pull(
    this.sbot.links({
      type: 'git-update',
      dest: this.feed,
      source: this.feed,
      rel: this.name,
      values: true
    }),
    pull.drain(function (msg) {
      // console.error('got link', msg)
      var update = msg.value.content.refs
      for (var name in update) {
        if (update[name])
          refs[name] = update[name]
        else
          delete refs[name]
      }
    }, function (err) {
      cb(err, refs)
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
  var objectsInfo = {}
  var ended
  var msg = {
    type: 'git-update',
    repo: this.name
  }
  msg[this.name] = this.feed

  if (readRefUpdates) {
    var doneReadingRefs = done()
    this.getRefs(function (err, refs) {
      if (err) return doneReadingRefs(err)
      // console.error('initial refs', refs)
      msg.refs = refs
      readRefUpdates(null, function next(end, update) {
        if (end) return doneReadingRefs(end === true ? null : end)
        if (update.old != refs[update.name])
          return doneReadingRefs(new Error(
            'Ref update old value is incorrect. ' +
            'ref: ' + update.name + ', ' +
            'old in update: ' + update.old + ', ' +
            'old in repo: ' + refs[update.name]
          ))
          refs[update.name] = update.new
        if (!ended)
          readRefUpdates(null, next)
      })
    })
  }

  if (readObjects) {
    var doneReadingObjects = done()
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
          cache[sha1] = objectsInfo[sha1] = {
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
  // console.error('adding object')

  // var self = this
  done(function (err) {
    ended = true
    if (err) return cb(err)
    // console.error('objects info', objectsInfo)
    // console.error('msg', msg)
    sbot.publish(msg, cb)
  })
}
