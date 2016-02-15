# ssb-git-repo

Host git repos in [secure-scuttlebutt][]

## API

#### `var repo = new GitSSBRepo(sbot, feed, name)`

Get a repo. No side effects. You can only push to the repo if your SSB client
has the private key for the feed ID of the repo.

- `sbot`: a [scuttlebot][] or [ssb-client][] object
- `feed`: ID of the SSB feed that owns the repo
- `name`: string name identifying the repo in the feed
- `repo`: an [abstract-pull-git-repo][]-compliant git repo object

[abstract-pull-git-repo]: https://github.com/clehner/abstract-pull-git-repo
[ssb-client]: https://github.com/ssbc/ssb-client
[scuttlebot]: https://github.com/ssbc/scuttlebot
[secure-scuttlebutt]: https://github.com/ssbc/secure-scuttlebutt
[pull-stream]: https://github.com/dominictarr/pull-stream

## TODO

- make lookup tables for SHA1 → git objects
- reuse index between a user's repos
- queue operations made before log is fully read
- handle closing live log index

## License

Copyright (c) 2016 Charles Lehner

Usage of the works is permitted provided that this instrument is
retained with the works, so that any entity that uses the works is
notified of this instrument.

DISCLAIMER: THE WORKS ARE WITHOUT WARRANTY.
