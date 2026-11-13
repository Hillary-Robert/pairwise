# Pairwise

Copy something on your laptop, paste it on your Android phone. Share a photo from your phone and
it lands in your computer's Downloads folder. That's the whole idea.

It works on macOS, Windows and Linux. On the same Wi-Fi the two talk directly, and if you run a
small relay server you can stay connected when you're out on mobile data. There are no accounts
and no cloud in the middle, and everything is encrypted end to end.

I started this after trying [PixelBridge](https://github.com/Okeroghenex/PixelBridge), which only
works on a Mac and only on the same network. I wanted the same thing on any computer, and away
from home too.

## What it does

- Anything you copy on the computer (text or images) shows up on the phone's clipboard.
- To send the other way, use Share > Computer, the "Send to computer" tile in Quick Settings, the
  button on the notification, or "Send clipboard" in the app.
- Drop files onto the desktop window to send them to the phone, or share them from the phone to
  the computer. Each file is checked with SHA-256 when it arrives.
- Pair by scanning a QR code, or type a short code if the camera isn't handy. Every phone gets its
  own key, so you can unpair one without affecting the others.

## How the repo is laid out

Everything is TypeScript. The protocol lives in one shared package that every app uses:

- `packages/core`: pairing, encryption, connections and file transfer
- `apps/desktop`: the desktop app (Electron)
- `apps/mobile`: the Android app (React Native with Expo), plus a small Kotlin module for things
  React Native can't do on its own, like the background service and the Quick Settings tile
- `apps/relay`: the optional relay server
- `apps/cli`: a command-line desktop and fake phone, handy for testing

If you want the details of how the phone and computer talk, see [PROTOCOL.md](PROTOCOL.md).

## Building it

You'll need Node.js 22.18 or newer. For the phone app you also need Android Studio (for the
Android SDK), Java 17, and an Android phone with USB debugging turned on.

```bash
npm install
npm run build
npm test
```

If you use VS Code, the repo comes with tasks for all of this: open the folder, then use
Terminal > Run Task. "Desktop app (Electron)" under Run and Debug starts the app with breakpoints
working.

### Desktop

```bash
cd apps/desktop
npm start        # run it
npm run dist     # build an installer (.dmg, .exe or AppImage/.deb)
```

A Pairwise icon appears in the menu bar or system tray. Click "Pair a phone" to get a QR code.

### Phone

Make sure `ANDROID_HOME` points at your Android SDK (on a Mac that's usually
`~/Library/Android/sdk`), plug in your phone, then:

```bash
cd apps/mobile
npx expo run:android
```

The first build takes a while. Once the app opens, tap "Scan the QR code" and point it at the
desktop window. If you just want an APK to install by hand, run `npm run build:apk` and look in
`android/app/build/outputs/apk/release/`.

### Relay

Only needed if you want it to work when your phone and computer are on different networks.
Instructions are in [apps/relay/README.md](apps/relay/README.md). The short version: put it on a
cheap VPS with a TLS certificate, enter its address in the desktop app's settings, and pair your
phone again so it picks up the address.

## Security

Pairing uses a one-time code that expires after 10 minutes. After that, each phone has its own
256-bit key, and every connection derives a fresh AES-256-GCM key from it (HKDF-SHA256 with random
values from both sides). Messages are numbered, so anything replayed, reordered or tampered with
gets rejected.

The relay never sees a key. It just passes encrypted bytes along, and the room name it uses can't
be traced back to you. On the local network, the desktop only answers phones that can prove they
were paired. Passwords copied from password managers aren't sent.

One thing it doesn't have yet is forward secrecy: if someone stole a device key, they could
decrypt traffic they'd recorded earlier. Adding a per-session X25519 exchange is on the list.

## Known limitations

- Android only lets the app that's on screen read the clipboard, so sending from the phone always
  takes a tap. There's no way around that without root or adb tricks.
- Some phones are aggressive about killing background apps. If the connection keeps dropping, tap
  "Allow" next to "Stay connected in the background" in the app's settings.

## What's next

- Phone notifications on the computer, with reply
- Incoming call alerts, SMS, battery level, find my phone
- Resumable transfers and more than one phone per computer
- Forward secrecy, signed builds and auto-update

## License

MIT