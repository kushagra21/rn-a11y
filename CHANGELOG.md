# Changelog

## 0.1.0 (unreleased)

- `audit` reads the native accessibility tree of the open screen on an iOS simulator (AXe or idb) or an Android emulator or device (uiautomator), with a screenshot.
- Rules: control-name, input-name, image-name, empty-stop, missing-role, target-size (WCAG 2.2 SC 2.5.8 with the spacing exception), platform-target-size, text-contrast, redundant-role, duplicate-name.
- Profiles `wcag22-aa` and `platform`; ignores and defaults in `rn-a11y.config.json`; `--fail-on` for CI; `--from` to re-audit a saved capture.
- HTML report with issues marked on the screenshot, severity filters, light and dark themes, and a manual checklist for the WCAG 2.2 AA criteria automation can't check.
- `doctor` and `rules` commands.
- Checked against a live React Native 0.83.6 app on iOS 27: AXe's repeated elements and scroll bars are dropped, `GenericElement` (a Pressable with no role) is recognized, and nested Text is checked for contrast once.
