var test = require('tape')
var GitSSBRepo = require('.')
var pullGitRepoTests = require('abstract-pull-git-repo/tests')
var ssbKeys = require('ssb-keys')
var pull = require('pull-stream')

var createSbot = require('scuttlebot')
  .use(require('scuttlebot/plugins/master'))
  .use(require('scuttlebot/plugins/blobs'))

var sbot = createSbot({
  temp: 'test-git-ssb-repo', timeout: 200,
  allowPrivate: true,
  keys: ssbKeys.generate()
})

test.onFinish(function () {
  sbot.close(true)
})

test('implement abstract pull git repo interface', function (t) {
  pullGitRepoTests(t.test, function () {
    return new GitSSBRepo(sbot, sbot.id, 'test')
  })
})
