# NOTICE

Car TV for the BMW MGU (iDrive 7).

## Kit / app framework
The `kit/` runtime and build tooling are based on the **idrive7-apps** project
(robertnisipeanu / cauliflowermossgrape), used under the **MIT License** (see `LICENSE`).

## ffmpeg
Car TV invokes a standalone **ffmpeg** binary fetched at build time from
`eugeneware/ffmpeg-static` (release b6.0, `ffmpeg-linux-x64`,
SHA-256 `ed652b2f32e0851d1946894fb8333f5b677c1b2ce6b9d187910a67f8b99da028`).
That build of ffmpeg is licensed under the **GPL**. It is executed as a separate process, not
linked into this app, and is not redistributed in this repository.

## Car TV app code
`apps/cartv/*.js` (the player, source resolver, m3u parser) is original to this project.
