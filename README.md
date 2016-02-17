# ssb-git

Host git repos in [secure-scuttlebutt][]

## Example

```js
var ssbGit = require('ssb-git')
var repoId = '%CBeVWA9eYt6OhJDXFtqas6kWb5LwaJxYtfwDazKvh4U=.sha256'

// get a single repo:
ssbGit.getRepo(sbot, repoId, function (err, repo) {
  if (err) throw err
  // do something with the repo
})
```

## API

#### `ssbGit.createRepo(sbot[, options], cb(err, repo))`

Create a repo. Publishes a message announcing the new repo.

- `sbot`: a [scuttlebot][] or [ssb-client][] object
- `options`: optional additional keys to add the repo creation message
  - `options.forks`: message ID of a repo of which this repo is considered a
    fork
- `cb`: function called when the repo is created
- `err`: error creating the repo, if any
- `repo`: `ssbGit.Repo` object for the new repo

#### `ssbGit.getRepo(sbot, repoId, cb(err, repo))`

Get a repo.

- `sbot`: a [scuttlebot][] or [ssb-client][] object
- `id`: ID of the SSB message that started the repo
- `cb`: function called when the repo is retrieved
- `err`: error retrieving the repo, if any
- `repo`: `ssbGit.Repo` object for the retrieved repo

#### `ssbGit.Repo`

An [abstract-pull-git-repo][]-compliant git repo object. Additional methods:

#### `repo.close(cb(err))`

Close the repo's update stream.

- `cb`: function called when the repo's stream is closed
- `err`: error closing the repo, if any

[abstract-pull-git-repo]: https://github.com/clehner/abstract-pull-git-repo
[ssb-client]: https://github.com/ssbc/ssb-client
[scuttlebot]: https://github.com/ssbc/scuttlebot
[secure-scuttlebutt]: https://github.com/ssbc/secure-scuttlebutt
[pull-stream]: https://github.com/dominictarr/pull-stream

## TODO

- reuse index between a user's repos
- handle push with more object IDs than fit in a message

## License

Copyright (c) 2016 Charles Lehner

Usage of the works is permitted provided that this instrument is
retained with the works, so that any entity that uses the works is
notified of this instrument.

DISCLAIMER: THE WORKS ARE WITHOUT WARRANTY.
