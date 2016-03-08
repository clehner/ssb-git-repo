var ref = require('ssb-ref')
var Repo = require('./lib/repo')
var pull = require('pull-stream')

exports.Repo = Repo

exports.createRepo = function (sbot, options, cb) {
  if (typeof options == 'function') cb = options, options = null
  if (!options) options = {}
  var msg = {
    type: 'git-repo'
  }
  if (options.forks) {
    if (!ref.isMsg(options.forks))
      throw new Error('Invalid repo ID: ' + options.forks)
    msg.forks = options.forks
  }
  sbot.publish(msg, function (err, msg) {
    var repo = new Repo(sbot, msg.key, msg.value)
    repo.synced = true
    if (options.live)
      repo._syncNew()
    cb(err, msg && repo)
  })
}

exports.getRepo = function (sbot, id, options, cb) {
  if (typeof options == 'function') cb = options, options = null
  if (!options) options = {}

  if (typeof id == 'object') {
    var msg = id.value
    id = id.key
    gotMsg(null, msg)
  } else {
    sbot.get(id, gotMsg)
  }

  function gotMsg(err, msg) {
    if (err) return cb(err)
    var repo = new Repo(sbot, id, msg)
    repo._sync(options.live)
    cb(null, repo)
  }
}

exports.repos = function (sbot, options) {
  return pull(
    sbot.createFeedStream(options),
    pull.filter(function (msg) {
      return msg.value.content.type === 'git-repo'
    }),
    pull.map(function (msg) {
      return new Repo(sbot, msg.key, msg.value)
    })
  )
}
