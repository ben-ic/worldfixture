# Third-party notices

This fixture is the upstream SeaweedFS image with a WorldFixture entry point and
two configuration files added. SeaweedFS itself is unmodified.

| Component | Repository | Upstream version | License |
| --- | --- | --- | --- |
| SeaweedFS | https://github.com/seaweedfs/seaweedfs | 4.41 (`de34a1a87c02893507f961cda9574172ee5064e9`) | Apache-2.0 |
| jq | https://github.com/jqlang/jq | Alpine package `1.8.2-r0` | MIT |
| socat | http://www.dest-unreach.org/socat/ | Alpine package `1.8.1.3-r0` | GPL-2.0-or-later |
| oniguruma (jq dependency) | https://github.com/kkos/oniguruma | Alpine package `6.9.10-r0` | BSD-2-Clause |

The upstream `chrislusf/seaweedfs` image ships no copyright file, so there is
none to preserve at a path inside the image. The Apache-2.0 licence text and the
NOTICE file are in the source repository above at the pinned revision.

Apache-2.0 requires that a modified distribution carry a notice of change. The
change is stated above: no SeaweedFS source or binary is patched; the image adds
`/usr/local/bin/worldfixture-s3`, `/etc/seaweedfs/filer.toml`,
`/etc/seaweedfs/master.toml`, this file, and the `jq` and `socat` packages.
