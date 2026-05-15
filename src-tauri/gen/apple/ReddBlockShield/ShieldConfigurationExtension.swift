import ManagedSettings
import ManagedSettingsUI
import UIKit

// MARK: - Pass 7: map system shielding context → App Group snapshot → labels

@available(iOS 16.0, *)
private enum ShieldSnapshotPresenter {
    /// Apple warns slow shield configuration falls back to defaults — keep work bounded.
    private static let maxSubtitleCharacters = 420

    /// Bundled in `ReddBlockShield.appex` (`Assets.xcassets` / `ShieldBrand`).
    /// Keep catalog PNGs modest in pixel size: very large @3x rasters decode to big bitmaps and can jetsam this extension.
    private static let brandIcon: UIImage? = {
        let bundle = Bundle(for: ShieldConfigurationExtension.self)
        return UIImage(named: "ShieldBrand", in: bundle, compatibleWith: nil) ?? UIImage(named: "ShieldBrand")
    }()

    private static let titleLabel = ShieldConfiguration.Label(
        text: "Blocked by ReDD Block",
        color: .label
    )

    private static let fallbackSubtitle = ShieldConfiguration.Label(
        text: "This content is restricted by ReDD Block.",
        color: .label
    )

    /// Brand primary action on the system shield (`#2A9D8F` fill, `#FFFFFF` title). iOS may soften at rest on material.
    private static let brandPrimaryActionFill = UIColor(red: 42 / 255, green: 157 / 255, blue: 143 / 255, alpha: 1)
    private static let brandPrimaryActionTitle = UIColor(red: 1, green: 1, blue: 1, alpha: 1)

    private static let fallbackConfiguration = shieldChromeConfiguration(subtitle: fallbackSubtitle)

    private static func shieldChromeConfiguration(subtitle: ShieldConfiguration.Label) -> ShieldConfiguration {
        let backgroundBlurStyle: UIBlurEffect.Style? = .systemMaterial
        let backgroundColor: UIColor? = .systemGroupedBackground
        let icon: UIImage? = brandIcon
        let title: ShieldConfiguration.Label? = titleLabel
        let primaryButtonLabel: ShieldConfiguration.Label? = ShieldConfiguration.Label(
            text: "OK",
            color: brandPrimaryActionTitle
        )
        let primaryButtonBackgroundColor: UIColor? = brandPrimaryActionFill
        let secondaryButtonLabel: ShieldConfiguration.Label? = nil
        return ShieldConfiguration(
            backgroundBlurStyle: backgroundBlurStyle,
            backgroundColor: backgroundColor,
            icon: icon,
            title: title,
            subtitle: subtitle,
            primaryButtonLabel: primaryButtonLabel,
            primaryButtonBackgroundColor: primaryButtonBackgroundColor,
            secondaryButtonLabel: secondaryButtonLabel
        )
    }

    static func configuration(
        shielding application: Application,
        category: ActivityCategory?
    ) -> ShieldConfiguration {
        guard let snapshot = SharedShieldSnapshotStore.load() else {
            return fallbackConfiguration
        }
        var rows: [ShieldAttribution] = []
        if let row = appAttribution(snapshot: snapshot, application: application) {
            rows.append(row)
        }
        if let category, let row = categoryAttribution(snapshot: snapshot, category: category) {
            rows.append(row)
        }
        guard let picked = bestAttribution(rows) else {
            return fallbackConfiguration
        }
        let blockedName = application.localizedDisplayName ?? "This app"
        return buildConfiguration(blockedName: blockedName, attribution: picked)
    }

    static func configuration(
        shielding webDomain: WebDomain,
        category: ActivityCategory?
    ) -> ShieldConfiguration {
        guard let snapshot = SharedShieldSnapshotStore.load() else {
            return fallbackConfiguration
        }
        var rows: [ShieldAttribution] = []
        if let row = domainAttribution(snapshot: snapshot, webDomain: webDomain) {
            rows.append(row)
        }
        if let category, let row = categoryAttribution(snapshot: snapshot, category: category) {
            rows.append(row)
        }
        guard let picked = bestAttribution(rows) else {
            return fallbackConfiguration
        }
        let raw = webDomain.domain?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let displayHost = raw.isEmpty ? "This site" : raw
        return buildConfiguration(blockedName: displayHost, attribution: picked)
    }

    // MARK: - Lookups (keys must match Pass 4–6 writers)

    private static func appAttribution(snapshot: ShieldUISnapshot, application: Application) -> ShieldAttribution? {
        let token = application.token
        guard let data = try? JSONEncoder().encode(token) else { return nil }
        let key = data.base64EncodedString()
        return ShieldAttributionPicker.winningAppRow(tokenDataKey: key, snapshot: snapshot)
    }

    private static func domainAttribution(snapshot: ShieldUISnapshot, webDomain: WebDomain) -> ShieldAttribution? {
        guard let raw = webDomain.domain?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        let key = ShieldSnapshotNormalization.normalizedWebHost(raw)
        guard !key.isEmpty else { return nil }
        return ShieldAttributionPicker.winningDomainRow(normalizedHost: key, snapshot: snapshot)
    }

    private static func categoryAttribution(snapshot: ShieldUISnapshot, category: ActivityCategory) -> ShieldAttribution? {
        let token = category.token
        guard let data = try? JSONEncoder().encode(token) else { return nil }
        let key = data.base64EncodedString()
        return ShieldAttributionPicker.winningCategoryRow(tokenDataKey: key, snapshot: snapshot)
    }

    private static func bestAttribution(_ rows: [ShieldAttribution]) -> ShieldAttribution? {
        rows.min(by: {
            ($0.enforcementStartedAtMs, $0.sourceId) < ($1.enforcementStartedAtMs, $1.sourceId)
        })
    }

    // MARK: - Shield.Configuration assembly

    private static func buildConfiguration(blockedName: String, attribution: ShieldAttribution) -> ShieldConfiguration {
        let subtitleText = truncate(makeSubtitle(blockedName: blockedName, attribution: attribution))
        let subtitle = ShieldConfiguration.Label(text: subtitleText, color: .label)
        return shieldChromeConfiguration(subtitle: subtitle)
    }

    private static func makeSubtitle(blockedName: String, attribution: ShieldAttribution) -> String {
        let opener = "\(blockedName) is on your current blocklist."
        var blockInfo: [String] = [detailSectionHeading(sourceId: attribution.sourceId)]
        let pill = pillLine(attribution: attribution)
        if !pill.isEmpty {
            blockInfo.append(pill)
        }
        if let timing = timingLine(attribution: attribution), !timing.isEmpty {
            blockInfo.append(timing)
        }
        return [opener, blockInfo.joined(separator: "\n")].joined(separator: "\n\n")
    }

    private static func detailSectionHeading(sourceId: String) -> String {
        if sourceId == "manual" {
            return "Block information:"
        }
        if sourceId.hasPrefix("schedule:") {
            return "Schedule information:"
        }
        return "Blocklist information:"
    }

    private static func pillLine(attribution: ShieldAttribution) -> String {
        let name = (attribution.blocklistName?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
        let emoji = (attribution.blocklistEmoji?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
        switch (emoji, name) {
        case let (e?, n?):
            return "\(e) \(n)"
        case let (e?, nil):
            return e
        case let (nil, n?):
            return n
        default:
            return "Blocklist: \(shortSource(attribution.sourceId))"
        }
    }

    private static func shortSource(_ sourceId: String) -> String {
        if sourceId == "manual" { return "manual block" }
        if sourceId.hasPrefix("schedule:") {
            return "schedule"
        }
        return sourceId
    }

    /// Manual “always on” blocks use a far-future `blockEndsAtMs` (see JS `ALWAYS_ON_END_TIME`). Skip
    /// `RelativeDateTimeFormatter` for those so the shield does not show absurd spans like “in 7000y”.
    private static let manualIndefiniteEndMinRemainingMs: Double = 50 * 365.25 * 24 * 60 * 60 * 1000

    private static func scheduleClockLabel(_ epochMs: Double) -> String {
        let tf = DateFormatter()
        tf.timeStyle = .short
        tf.dateStyle = .none
        tf.locale = .current
        return tf.string(from: Date(timeIntervalSince1970: epochMs / 1000))
    }

    private static func timingLine(attribution: ShieldAttribution) -> String? {
        let nowMs = Date().timeIntervalSince1970 * 1000

        if attribution.sourceId.hasPrefix("schedule:"),
           let sMs = attribution.blockStartedAtMs,
           let eMs = attribution.blockEndsAtMs {
            if eMs > nowMs {
                return "Started: \(scheduleClockLabel(sMs))\nEnds: \(scheduleClockLabel(eMs))"
            }
            return "Started: \(scheduleClockLabel(sMs))\nEnded: \(scheduleClockLabel(eMs))"
        }

        if let endMs = attribution.blockEndsAtMs {
            let end = Date(timeIntervalSince1970: endMs / 1000)
            if endMs > nowMs {
                if attribution.sourceId == "manual", endMs - nowMs >= manualIndefiniteEndMinRemainingMs {
                    return "Always on"
                }
                let rel = RelativeDateTimeFormatter()
                rel.unitsStyle = .short
                return "Ends \(rel.localizedString(for: end, relativeTo: Date()))."
            }
            let tf = DateFormatter()
            tf.timeStyle = .short
            tf.dateStyle = .none
            return "Ended \(tf.string(from: end))."
        }
        if let startMs = attribution.blockStartedAtMs {
            let start = Date(timeIntervalSince1970: startMs / 1000)
            let tf = DateFormatter()
            tf.timeStyle = .short
            tf.dateStyle = .none
            return "Started \(tf.string(from: start))."
        }
        return nil
    }

    private static func truncate(_ s: String) -> String {
        guard s.count > maxSubtitleCharacters else { return s }
        let idx = s.index(s.startIndex, offsetBy: maxSubtitleCharacters - 1)
        return String(s[..<idx]) + "…"
    }

}

/// Shield configuration: reads `ShieldUISnapshot` from the App Group and maps `shielding` to labels.
@available(iOS 16.0, *)
final class ShieldConfigurationExtension: ShieldConfigurationDataSource {
    override func configuration(shielding application: Application) -> ShieldConfiguration {
        ShieldSnapshotPresenter.configuration(shielding: application, category: nil)
    }

    override func configuration(shielding application: Application, in category: ActivityCategory) -> ShieldConfiguration {
        ShieldSnapshotPresenter.configuration(shielding: application, category: category)
    }

    override func configuration(shielding webDomain: WebDomain) -> ShieldConfiguration {
        ShieldSnapshotPresenter.configuration(shielding: webDomain, category: nil)
    }

    override func configuration(shielding webDomain: WebDomain, in category: ActivityCategory) -> ShieldConfiguration {
        ShieldSnapshotPresenter.configuration(shielding: webDomain, category: category)
    }
}
