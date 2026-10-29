# Changelog

## 0.1.0 (2026-10-29)

First release.

- `audit`: reads the native accessibility tree of the open screen, the one VoiceOver and TalkBack use, on an iOS simulator (AXe or idb) or an Android emulator or device (uiautomator), takes a screenshot, and reports each issue with its WCAG 2.2 criterion and a fix.
- `watch`: audits each new screen as you move through the app, into one report with a section per screen. Screens are recognized by their content, so revisiting one, or a number changing, doesn't audit it again.
- `audit --links` / `--url`: opens each deep link (a `.deeplinks.json` as rn-deeplink writes it, a text file, or URLs), waits for the screen to settle and audits it. Links that don't open are reported and fail the run.
- Rules: control-name, input-name (a placeholder alone is serious), image-name, empty-stop, missing-role, target-size (WCAG 2.2 SC 2.5.8 with its spacing exception), platform-target-size (Apple HIG 44pt, Material 48dp), text-contrast (measured from screenshot pixels), redundant-role, duplicate-name.
- Profiles `wcag22-aa` and `platform`; ignores and defaults in `rn-a11y.config.json`; `--fail-on` for CI; `--from` to re-audit a saved capture without a device.
- HTML report with issues marked on the screenshot, severity filters, light and dark themes, and a checklist of the WCAG 2.2 AA criteria automation can't check.
- `doctor` and `rules` commands.
- Checked against a bare React Native 0.83.6 app (New Architecture) on an iOS 27 simulator and an Android 17 (API 37) emulator.
