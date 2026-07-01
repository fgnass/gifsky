# Gifsky

Turn a video into a GIF, right in your browser. Drop in a
clip, trim it on a timeline, preview the loop, and export.
It's an installable PWA that works offline.

Nothing is ever uploaded: every frame is sampled and encoded **on your device**.

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src="public/screenshots/start.png" alt="Gifsky landing screen with an Open Video button" width="320"><br>
      <sub>Drop or pick a clip — everything stays on your device.</sub>
    </td>
    <td align="center" width="50%">
      <img src="public/screenshots/editor.png" alt="The editor: loop preview, trim timeline, and quality settings" width="320"><br>
      <sub>Trim on the timeline, preview the loop, and tune quality or target size.</sub>
    </td>
  </tr>
</table>

## The name

Gifsky encodes with [**gifski**](https://gif.ski/), the high-quality GIF encoder.
Add a _sky_ and you get a web app living in the cloud — even though, ironically, all the
work happens locally and never leaves your device.

## Run

```sh
npm install
npm run dev
```

Then open http://localhost:5173/.

## License

Gifsky is licensed under the **GNU Affero General Public License v3.0 or later**
([AGPL-3.0-or-later](LICENSE)) required for compatibility with the bundled gifski
encoder, which is AGPL.

Copyright © 2026 Felix Gnass.
