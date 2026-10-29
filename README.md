# rn-a11y

Audit the accessibility of a running React Native app. Open a screen on an iOS simulator or an Android emulator or device, run one command, and get the issues a screen reader user would hit, each tied to a WCAG 2.2 success criterion, with an HTML report that marks every issue on a screenshot.

```bash
npx rn-a11y audit
```

```
iOS · Shop · iPhone 18 Pro, iOS 27.0
8 issues: 2 critical, 3 serious, 2 moderate, 1 minor

 1 ✖ CRITICAL Button has no accessible name, so VoiceOver can't say what it does.
              testID="close" at 16,62 30×30 · control-name · WCAG 2.2 SC 4.1.2
              → Add accessibilityLabel describing what it does, e.g. accessibilityLabel="Close".
 4 ✖ SERIOUS  Touch target is 20×20pt and too close to another target (minimum 24×24pt).
              testID="favorite" at 47,66 20×20 · target-size · WCAG 2.2 SC 2.5.8
 5 ✖ SERIOUS  Contrast is 2.54:1 (#9CA3AF on #FFFFFF); text needs 4.5:1, or 3:1 if large.
              "Apply coupon" at 280,340 106×24 · text-contrast · WCAG 2.2 SC 1.4.3
…
Report: a11y-report/report.html
```

## How it works

rn-a11y reads the **native accessibility tree**, the same one VoiceOver and TalkBack use, and takes a screenshot at the same moment:

| | Tree | Screenshot |
|---|---|---|
| Android | `adb shell uiautomator dump` | `adb shell screencap` |
| iOS simulator | [AXe](https://github.com/cameroncooke/AXe) (`axe describe-ui`) or [idb](https://fbidb.io) | `xcrun simctl io screenshot` |

Nothing is added to your app. Because it reads what the native platform exposes, it doesn't depend on the React Native version or architecture. It has been checked against a bare React Native 0.83.6 app (New Architecture) on an iOS 27 simulator; that capture is part of the test suite.

## Requirements

- Node 22.12 or newer
- **Android:** `adb` (Android Studio or the SDK Platform-Tools). Emulators and USB devices both work.
- **iOS:** macOS with Xcode, a booted simulator, and AXe:
  ```bash
  brew install cameroncooke/axe/axe
  ```

Run `npx rn-a11y doctor` to check what's installed and which devices are running.

## Usage

```bash
rn-a11y audit                          # every running platform
rn-a11y audit -p ios                   # one platform
rn-a11y audit -n checkout              # name the screen: a11y-report/checkout/
rn-a11y audit --profile platform       # add Apple HIG 44pt / Material 48dp targets
rn-a11y audit --fail-on serious        # exit 1 for CI
rn-a11y audit --from a11y-report       # re-run the rules on a saved capture, no device needed
rn-a11y audit --json                   # machine-readable output
rn-a11y rules                          # list the rules
```

Every audit writes `report.html`, `report.json`, and per-platform `snapshot.json`, `screenshot.png` and the raw tree to the report folder.

## Rules

| Rule | Checks | Source |
|---|---|---|
| `control-name` | Tappable elements have an accessible name | WCAG 2.2 SC 4.1.2 |
| `input-name` | Text fields have a label | WCAG 2.2 SC 4.1.2, 3.3.2 |
| `image-name` | Images have a text alternative, or are hidden (needs review) | WCAG 2.2 SC 1.1.1 |
| `empty-stop` | VoiceOver never stops on an element with nothing to read (iOS) | WCAG 2.2 SC 4.1.2 |
| `missing-role` | Tappable elements have `accessibilityRole` (on iOS, flagged for review) | WCAG 2.2 SC 4.1.2 |
| `target-size` | Targets are 24×24, or spaced so a 24-wide circle around them touches nothing | WCAG 2.2 SC 2.5.8 |
| `platform-target-size` | 44×44pt on iOS, 48×48dp on Android (`--profile platform`) | Apple HIG, Material Design |
| `text-contrast` | Text reaches 4.5:1; 3:1–4.5:1 is flagged for review, as it passes only for large text | WCAG 2.2 SC 1.4.3 |
| `redundant-role` | Labels don't repeat the role ("Submit button") | Apple HIG, Android guidelines |
| `duplicate-name` | Controls on a screen have distinct names | WCAG 2.2 SC 2.4.6 (advisory) |

Automated checks find roughly a third of WCAG issues. The HTML report ends with a checklist of the WCAG 2.2 AA criteria for mobile that need a person, such as reading order, large text and gesture alternatives.

## Configuration

`rn-a11y.config.json` in the project root:

```json
{
  "profile": "wcag22-aa",
  "package": "com.example.shop",
  "failOn": "serious",
  "ignore": [
    { "rule": "duplicate-name" },
    { "rule": "image-name", "testID": "hero-background" },
    { "rule": "text-contrast", "name": "Terms apply" }
  ]
}
```

## Limits

- Only the screen that's open is audited; navigate to each screen and run it again.
- `hitSlop` is handled in JavaScript and isn't visible in the native tree, so a small target with a big `hitSlop` is still reported. Ignore it by `testID` once you've checked.
- iOS doesn't expose whether an element without `accessibilityRole` is tappable: a role-less Pressable looks the same as a View with `accessible={true}`. On iOS, `missing-role` asks for a review, and a role-less element with no label is reported by `empty-stop`. Role-less controls also aren't measured for target size on iOS.
- Decorative images can't be told apart from meaningful ones, so `image-name` asks for a review.
- Contrast is measured from screenshot pixels; text over photos or gradients is skipped and listed in the notes.
- iOS physical devices aren't supported yet, only simulators.

## License

MIT
