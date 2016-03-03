# ssb-git-repo

Host git repos in [secure-scuttlebutt][]

## Example

```js
var ssbGit = require('ssb-git-repo')
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
- `options.forks`: message ID of a repo of which this repo is considered a fork
- `options.live`: keep the repo updated as changes are pushed to it
- `cb`: function called when the repo is created
- `err`: error creating the repo, if any
- `repo`: `ssbGit.Repo` object for the new repo

#### `ssbGit.getRepo(sbot, repoId[, options], cb(err, repo))`

Get a repo.

- `sbot`: a [scuttlebot][] or [ssb-client][] object
- `id`: ID of the SSB message that started the repo
- `options.live`: keep the repo updated as changes are pushed to it
- `cb`: function called when the repo is retrieved
- `err`: error retrieving the repo, if any
- `repo`: `ssbGit.Repo` object for the retrieved repo

#### `ssbGit.repos(sbot, options): source(repo)`

Get repos from the feed

- `sbot`: a [scuttlebot][] or [ssb-client][] object
- `options`: options to pass to `sbot.createFeedStream`
- `repo`: `ssbGit.Repo` object

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

### Schema

#### type: git-repo

```js
{ type: 'git-repo' }
```

Creates a git repo. Note that you can actually push git objects to any message
in your feed, but the `git-repo` type is here to declare that a message will be
for a git repo. It may have properties added later.

#### type: git-update

```js
{
  type: 'git-update',
  repo: MsgId,
  refs: { <ref>: String? }?,
  objects: [ { type: String, length: Number, sha1: String, link: BlobId } ]?,
  packs: [ { link: BlobId } ]?,
  packidx: [ { link: BlobId } ]?,
}
```
Updates a repo. Published as a result of `git push`.
- `repo`: id of a message (expected of type `git-repo`) identifying the repo
- `refs`: updates to the repo's refs. a map of ref names to git sha1 hashes.
  e.g. `{ 'refs/heads/master': commitId }`
- `objects`: git objects being added to the repo.
  - `object.type`: one of `["commit", "tree", "blob", "tag"]`
  - `object.length`: size in bytes of the git object
  - `object.sha1`: SHA1 hash of the git object
  - `object.link`: id of the ssb blob containing the git object's data.
- `packs`: git packfiles being added to the repo.
- `packidx`: git pack index files for the packfiles being added. Each item in
    `packidx` corresponds to an item in `packs`.

## TODO

- reuse index between a user's repos
- handle push with more object IDs than fit in a message

## License

Copyright (c) 2016 Charles Lehner

Usage of the works is permitted provided that this instrument is
retained with the works, so that any entity that uses the works is
notified of this instrument.

DISCLAIMER: THE WORKS ARE WITHOUT WARRANTY.
