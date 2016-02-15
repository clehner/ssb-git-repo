# ssb-git

Host git repos in [secure-scuttlebutt][]

## Example

```js
var ssbGit = require('ssb-git')
var feedId = '@RLJOvvDzsBJqr/kYCpK2u4kBWjqQS9LDtg2lZpGYgo0=.ed25519'
var repoName = 'example'

// get a single repo:
ssbGit.getRepo(sbot, feedId, repoName, function (err, repo) {
  if (err) throw err
  // do something with the repo
})
```

## API

#### `ssbGit.getRepo(sbot, feedId, repoName, cb(err, repo))`

Get a repo from the given feed by the given name.

- `sbot`: a [scuttlebot][] or [ssb-client][] object
- `feedId`: ID of the SSB feed containing the repo
- `repoName`: the name of the repo in the feed
- `cb`: function called when the repo is retrieved
- `err`: error retrieving the feed, if any
- `repo`: `ssbGit.Repo` object for the repo being retrieved

#### `ssbGit.getFeedRepos(sbot, feedId, cb(err, feedRepos))`

Get all repos in a given feed

- `feedRepos`: `ssbGit.FeedRepos` object for the repos being retrieved

#### `ssbGit.getAllRepos(sbot, cb(err, allRepos)`

Get all repos in the network

- `allRepos`: `ssbGit.Repos` object for the repos being retrieved

#### `allRepos.getFeedRepos(feedId): feedRepos`

Get repos for a single feed, from the full repos

#### `feedRepos.getRepo(repoName): repo`

Get a repo. No side effects. You can only push to the repo if your SSB client
has the private key for the feed ID of the repo.

- `sbot`: a [scuttlebot][] or [ssb-client][] object
- `feed`: ID of the SSB feed that owns the repo
- `name`: string name identifying the repo in the feed
- `repo`: a `ssbGit.Repo` object representing the git repo

#### `ssbGit.Repo`

An [abstract-pull-git-repo][]-compliant git repo object. Additional methods:

#### `Repo.close(cb(err))`

- `cb`: function called when the repo's stream is closed
- `err`: error closing the repo, if any

Close the repo's update stream

[abstract-pull-git-repo]: https://github.com/clehner/abstract-pull-git-repo
[ssb-client]: https://github.com/ssbc/ssb-client
[scuttlebot]: https://github.com/ssbc/scuttlebot
[secure-scuttlebutt]: https://github.com/ssbc/secure-scuttlebutt
[pull-stream]: https://github.com/dominictarr/pull-stream

## TODO

- reuse index between a user's repos
- queue operations made before log is fully read
- handle push with more object IDs than fit in a message

## License

Copyright (c) 2016 Charles Lehner

Usage of the works is permitted provided that this instrument is
retained with the works, so that any entity that uses the works is
notified of this instrument.

DISCLAIMER: THE WORKS ARE WITHOUT WARRANTY.
