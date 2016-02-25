var test = require('tape')
var ssbGit = require('..')
var ssbKeys = require('ssb-keys')
var pull = require('pull-stream')
var pullGitRepoTests = require('abstract-pull-git-repo/tests')
var u = require('scuttlebot/test/util')
var multicb = require('multicb')

var createSbot = require('scuttlebot')
  .use(require('scuttlebot/plugins/master'))
  .use(require('scuttlebot/plugins/blobs'))
  .use(require('scuttlebot/plugins/gossip'))
  .use(require('scuttlebot/plugins/friends'))
  .use(require('scuttlebot/plugins/replicate'))

function awaitGossip(sbot, sbot2, cb) {
  sbot2.latestSequence(sbot2.id, function (err, seq) {
    if (err) return cb(err)
    pull(
      sbot.createHistoryStream(sbot2.id, seq.sequence, true),
      pull.drain(function (msg) {
        cb()
        return false
      })
    )
  })
}

test('repo updates replicate through pubs', function (t) {

  var pub = createSbot({
    temp: 'test-git-ssb-pub', timeout: 200,
    allowPrivate: true,
    keys: ssbKeys.generate()
  })

  var alice = createSbot({
    temp: 'test-git-ssb-alice', timeout: 200,
    allowPrivate: true,
    keys: ssbKeys.generate(),
    seeds: [pub.getAddress()]
  })

  var bob = createSbot({
    temp: 'test-git-ssb-bob', timeout: 200,
    allowPrivate: true,
    keys: ssbKeys.generate(),
    seeds: [pub.getAddress()]
  })

  t.test('alice and bob follow eachother', function (t) {
    t.plan(1)
    var done = multicb()
    pub.publish(u.follow(alice.id), done())
    pub.publish(u.follow(bob.id), done())
    alice.publish(u.follow(bob.id), done())
    bob.publish(u.follow(alice.id), done())
    done(function (err, res) {
      t.error(err, 'published follows')
    })
  })

  t.test('repo replicated between peers', function (t) {
    var opt = {live: true}
    ssbGit.createRepo(alice, function (err, repoAlice) {
      t.error(err, 'created repo')
      awaitGossip(bob, alice, function (err) {
        t.error(err, 'await gossip')
        ssbGit.getRepo(bob, repoAlice.id, opt, function (err, repoBob) {
          t.error(err, 'got repo')
          t.ok(repoBob, 'repo')
          t.end()
        })
      })
    })
  })

  t.test('git objects are replicated', function (t) {
    var opt = {live: true}
    ssbGit.createRepo(alice, function (err, repoA) {
      t.error(err, 'created repo')
      // TODO: generate a new git update instead of using pre-existing one
      var update = pullGitRepoTests.getUpdate(0)
      repoA.update(update.refs, update.objects, function (err) {
        t.error(err, 'pushed update')
        t.test('objects are added', function (t) {
          awaitGossip(bob, alice, function (err) {
            t.error(err, 'await gossip')
            ssbGit.getRepo(bob, repoA.id, opt, function (err, repoB) {
              pullGitRepoTests.testObjectsAdded(t, repoB, update.hashes)
              t.end()
            })
          })
        })
      })
    })
  })

  t.test('close the sbots', function (t) {
    t.plan(3)
    pub.close(null, function (err) {
      t.error(err, 'closed pub')
    })
    alice.close(null, function (err) {
      t.error(err, 'closed alice sbot')
    })
    bob.close(null, function (err) {
      t.error(err, 'closed bob sbot')
    })
  })
})
