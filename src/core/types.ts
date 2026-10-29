export type Platform = "ios" | "android";

/** A rectangle in points (iOS) or dp (Android), relative to the top-left of the screen. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the element is, as the screen reader would announce it. */
export type Kind =
  | "button"
  | "link"
  | "image"
  | "text"
  | "input"
  | "switch"
  | "checkbox"
  | "radio"
  | "slider"
  | "tab"
  | "header"
  | "scroll"
  | "container"
  | "other";

/** One element of the native accessibility tree, normalized across platforms. */
export interface A11yNode {
  /** Index path from the root, e.g. "0.3.1". Stable within one snapshot. */
  id: string;
  kind: Kind;
  /** The native class (Android) or element type (iOS), e.g. "android.view.ViewGroup" or "Button". */
  className: string;
  /** The label set on the element itself: content-desc on Android, AXLabel on iOS. */
  label: string;
  /** Text content: the text attribute on Android, AXValue on iOS. */
  text: string;
  /** Android hint (placeholder) of a text field. */
  hint?: string;
  /** React Native testID: resource-id on Android, accessibilityIdentifier on iOS. */
  testID?: string;
  frame: Rect;
  /** Handles taps, so it is a pointer target (WCAG 2.5.8). */
  interactive: boolean;
  /** The screen reader stops on it. */
  focusable: boolean;
  enabled: boolean;
  /** Android package that owns the element. */
  package?: string;
  children: A11yNode[];
}

/** An RGBA image, 4 bytes per pixel. */
export interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface DeviceInfo {
  platform: Platform;
  id: string;
  name: string;
  /** e.g. "iOS 27.0" or "emulator" */
  detail?: string;
}

/** Everything the rules need about one screen, captured at one moment. */
export interface Snapshot {
  platform: Platform;
  device: DeviceInfo;
  /** iOS app name or Android package. */
  app?: string;
  /** Screen size in points (iOS) or dp (Android). */
  screen: { width: number; height: number };
  /** Screenshot pixels per point or dp. */
  scale: number;
  capturedAt: string;
  root: A11yNode;
  screenshot?: Image;
}

export type Severity = "critical" | "serious" | "moderate" | "minor";

export const SEVERITIES: Severity[] = ["critical", "serious", "moderate", "minor"];

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  fix: string;
  /** Where the requirement comes from, e.g. "WCAG 2.2 SC 4.1.2" or "Apple HIG". */
  source: string;
  /** The tool can't be sure: a person should check it. */
  review?: boolean;
  node: {
    id: string;
    className: string;
    frame: Rect;
    name: string;
    testID?: string;
  };
}

export type ProfileName = "wcag22-aa" | "platform";

export interface AuditResult {
  platform: Platform;
  device: DeviceInfo;
  app?: string;
  profile: ProfileName;
  capturedAt: string;
  findings: Finding[];
  /** Rules that ran, so a clean report says what was checked. */
  rules: { id: string; title: string; source: string }[];
  /** Why some checks couldn't run, e.g. no screenshot for contrast. */
  notes: string[];
  stats: { elements: number; targets: number; texts: number };
}
