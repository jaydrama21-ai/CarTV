# Car TV — live TV / IPTV & web video on the iDrive 7 (MGU)

A custom OAP app for the rooted BMW MGU (iDrive 7) head unit. It plays an **m3u/Xtream
playlist**, a **direct HLS stream**, or (via `yt-dlp`) **YouTube and ~1800 other sites**,
decoding on the head unit with a **bundled static ffmpeg** and drawing the picture on the
center screen through the GPU renderer. **Parked-only by default.**

> The free, update-proof alternative to the CarPlay video apps (APTV / TeleCar). Runs on your
> head unit, not on Apple's rules.

## Add it to your MGU Store

1. In the Store → **Settings → Sources**, add this repo as `owner/repo`.
2. Install **Car TV** from Available. The unit builds it from source with your `oap-sdk` and
   pulls the bundled `ffmpeg` (a static x86-64 build) at build time.
3. Open **Car TV → Settings**, paste a playlist or stream URL, press **Play** (while parked).

## Requirements

- A **rooted MGU** with the custom-apps platform installed (GPU renderer + controller gate).
- The **`oap-sdk`** present on the unit for the build (not committed here — copyright).
- **Internet on the unit** for streaming — the MGU's `wlan0` joins your **phone's hotspot**
  (managed by the Internet uplink app). Car TV's uid must be allowed through the uplink.

## Status

- **v0.1.0** — picture only. Audio to the car speakers is the open piece (the MGU routes audio
  over BMW's closed AVB/media-engine path; under investigation).
- Hardware decode (VAAPI, Intel GPU) is supported by the player and makes 1080p realistic; the
  default is safe software decode until confirmed on-unit.

## Credits & licenses

- App framework / kit: based on the MIT-licensed kit from the `idrive7-apps` project
  (robertnisipeanu / cauliflowermossgrape). See `NOTICE.md`.
- `ffmpeg`: a static build from [eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)
  (GPL). Fetched by SHA-256 at build time; not redistributed in this repo.
- The icon is an original cat-on-TV meme drawn for this app.
