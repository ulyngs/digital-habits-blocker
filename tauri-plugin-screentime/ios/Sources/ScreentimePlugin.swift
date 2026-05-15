import SwiftRs
import Tauri
import UIKit
import SwiftUI
import FamilyControls
import ManagedSettings
import DeviceActivity

// MARK: - Argument Types

class AuthorizationArgs: Decodable {}

class BlockWebsitesArgs: Decodable {
    let domains: [String]
}

class UnblockWebsitesArgs: Decodable {}

class BlockAppsForTokensArgs: Decodable {
    let tokenData: [String]  // Base64-encoded ApplicationToken data
}

class UnblockAppsArgs: Decodable {}

class StartBlockArgs: Decodable {
    let domains: [String]
    let appTokenData: [String]?
    let categoryTokenData: [String]?
    let blocklistEmoji: String?
    let blocklistName: String?
    let blocklistColorHex: String?
    let blockStartMs: Double?
    let blockEndMs: Double?
}

class ScheduleBlockArgs: Decodable {
    let id: String?
    let startHour: Int
    let startMinute: Int
    let endHour: Int
    let endMinute: Int
    let domains: [String]?
    let appTokenData: [String]?  // Base64-encoded ApplicationToken data
    let categoryTokenData: [String]?  // Base64-encoded ActivityCategoryToken data
}

class UnscheduleBlockArgs: Decodable {
    let id: String?  // If nil, unschedule all
}

class ScheduleEntry: Decodable {
    let id: String
    let startHour: Int
    let startMinute: Int
    let endHour: Int
    let endMinute: Int
    let domains: [String]?
    let appTokenData: [String]?
    let categoryTokenData: [String]?
    /// Optional weekday filter: Mon=0 … Sun=6
    let days: [Int]?
    /// Whether DeviceActivity should repeat this schedule entry.
    let repeats: Bool?
    /// Optional active window start/end (epoch milliseconds). Extension uses this
    /// to enforce non-repeating and date-limited schedule semantics.
    let activeFromTimestampMs: Double?
    let activeUntilTimestampMs: Double?
    /// Optional pause state propagated from the JS schedule model.
    let isPaused: Bool?
    let pauseEndTimestampMs: Double?
    /// Blocklist presentation for shield snapshot (optional).
    let blocklistEmoji: String?
    let blocklistName: String?
    let blocklistColorHex: String?
}

class SetSchedulesArgs: Decodable {
    let schedules: [ScheduleEntry]
}

class ShowActivityPickerArgs: Decodable {
    let initialApplicationTokenData: [String]?
    let initialCategoryTokenData: [String]?
}

// One-off DeviceActivity (pause resume / block end)
class RegisterOneOffActivityArgs: Decodable {
    let activityName: String
    let startTimestampMs: Double
}

class SetResumePayloadArgs: Decodable {
    let blockId: String
    let domains: [String]
    let appTokenData: [String]?
    let categoryTokenData: [String]?
}

class SetBlockEndStateArgs: Decodable {
    let blockId: String
    let domains: [String]
    let appTokenData: [String]?
    let categoryTokenData: [String]?
}

// MARK: - Activity Picker SwiftUI View

@available(iOS 16.0, *)
private enum PickerStep {
    case picker
    case review
}

@available(iOS 16.0, *)
private struct SelectedReviewView: View {
    let selection: FamilyActivitySelection
    let onDone: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Selected")
                    .font(.headline)

                let totalApps = selection.applicationTokens.count
                let totalCats = selection.categoryTokens.count
                let totalWebs = selection.webDomainTokens.count

                if totalApps == 0 && totalCats == 0 && totalWebs == 0 {
                    Text("No items selected")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    Text(summaryText(apps: totalApps, categories: totalCats, domains: totalWebs))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 10)

            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if !selection.categoryTokens.isEmpty {
                        Text("Categories")
                            .font(.caption2)
                            .fontWeight(.semibold)
                            .foregroundColor(.secondary)
                            .textCase(.uppercase)
                            .padding(.horizontal)
                            .padding(.top, 8)

                        ForEach(Array(selection.categoryTokens), id: \.self) { token in
                            Label(token)
                                .labelStyle(.titleAndIcon)
                                .font(.subheadline)
                                .padding(.horizontal)
                                .padding(.vertical, 6)
                        }
                    }

                    if !selection.applicationTokens.isEmpty {
                        Text("Apps")
                            .font(.caption2)
                            .fontWeight(.semibold)
                            .foregroundColor(.secondary)
                            .textCase(.uppercase)
                            .padding(.horizontal)
                            .padding(.top, 8)

                        ForEach(Array(selection.applicationTokens), id: \.self) { token in
                            Label(token)
                                .labelStyle(.titleAndIcon)
                                .font(.subheadline)
                                .padding(.horizontal)
                                .padding(.vertical, 6)
                        }
                    }

                    if !selection.webDomainTokens.isEmpty {
                        Text("Websites")
                            .font(.caption2)
                            .fontWeight(.semibold)
                            .foregroundColor(.secondary)
                            .textCase(.uppercase)
                            .padding(.horizontal)
                            .padding(.top, 8)

                        ForEach(Array(selection.webDomainTokens), id: \.self) { token in
                            Label(token)
                                .labelStyle(.titleAndIcon)
                                .font(.subheadline)
                                .padding(.horizontal)
                                .padding(.vertical, 6)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    private func summaryText(apps: Int, categories: Int, domains: Int) -> String {
        var parts: [String] = []
        if apps > 0 { parts.append("\(apps) app\(apps > 1 ? "s" : "")") }
        if categories > 0 { parts.append("\(categories) categor\(categories > 1 ? "ies" : "y")") }
        if domains > 0 { parts.append("\(domains) domain\(domains > 1 ? "s" : "")") }
        return parts.joined(separator: ", ")
    }
}

@available(iOS 16.0, *)
struct ActivityPickerView: View {
    @State private var selection: FamilyActivitySelection
    @State private var step: PickerStep = .picker
    let initialSelection: FamilyActivitySelection

    init(initialSelection: FamilyActivitySelection = FamilyActivitySelection(), onDone: @escaping (FamilyActivitySelection) -> Void, onCancel: @escaping () -> Void) {
        self._selection = State(initialValue: initialSelection)
        self.initialSelection = initialSelection
        self.onDone = onDone
        self.onCancel = onCancel
    }
    private let onDone: (FamilyActivitySelection) -> Void
    private let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if step == .picker {
                    FamilyActivityPicker(selection: $selection)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    SelectedReviewView(selection: selection, onDone: { onDone(selection) })
                }
            }
            .navigationTitle(step == .picker ? "Select Apps" : "Selected")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if step == .picker {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            onCancel()
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Next") {
                            step = .review
                        }
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Back") {
                            step = .picker
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            onDone(selection)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Screen Time Plugin

@available(iOS 16.0, *)
class ScreentimePlugin: Plugin {
    
    private let store = ManagedSettingsStore()
    private let center = DeviceActivityCenter()
    
    // Persist the current selection to the App Group's UserDefaults so it survives
    // app restarts AND is accessible to the DeviceActivityMonitor extension.
    // ManagedSettingsStore persists blocks at the OS level, but we need the selection
    // to re-apply blocks and show the picker state.
    private static let selectionKey = "redd.activitySelection"
    private static let authorizationApprovedKey = "redd.authorizationApproved"
    
    private static var sharedDefaults: UserDefaults? {
        return UserDefaults(suiteName: appGroupID)
    }
    
    private static var currentSelection: FamilyActivitySelection {
        get {
            if let data = sharedDefaults?.data(forKey: selectionKey),
               let selection = try? JSONDecoder().decode(FamilyActivitySelection.self, from: data) {
                return selection
            }
            return FamilyActivitySelection()
        }
        set {
            if let data = try? JSONEncoder().encode(newValue) {
                sharedDefaults?.set(data, forKey: selectionKey)
            }
        }
    }

    private static var hasCachedAuthorizationApproval: Bool {
        get {
            sharedDefaults?.bool(forKey: authorizationApprovedKey) ?? false
        }
        set {
            sharedDefaults?.set(newValue, forKey: authorizationApprovedKey)
        }
    }
    
    // MARK: - Authorization

    /// FamilyControls reports `authorizationStatus` as `.notDetermined` on a fresh
    /// app launch even when the OS-level grant is still active. Persist the last
    /// known approved state so onboarding and native commands stay in sync across launches.
    private func resolvedAuthorizationStatus() -> AuthorizationStatus {
        let readStatus = {
            let status = AuthorizationCenter.shared.authorizationStatus
            switch status {
            case .approved:
                Self.hasCachedAuthorizationApproval = true
                return status
            case .denied:
                Self.hasCachedAuthorizationApproval = false
                return status
            case .notDetermined:
                return Self.hasCachedAuthorizationApproval ? .approved : status
            @unknown default:
                return status
            }
        }

        if Thread.isMainThread {
            return readStatus()
        }

        return DispatchQueue.main.sync(execute: readStatus)
    }
    
    @objc public func requestAuthorization(_ invoke: Invoke) throws {
        Task { @MainActor in
            do {
                try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
                let status = self.resolvedAuthorizationStatus()
                invoke.resolve([
                    "granted": status == .approved,
                    "status": self.statusString(status)
                ])
            } catch {
                // iOS can occasionally report a cancellation error even though the
                // authorization state has already switched to approved.
                let status = self.resolvedAuthorizationStatus()
                if status == .approved {
                    invoke.resolve([
                        "granted": true,
                        "status": self.statusString(status)
                    ])
                    return
                }
                invoke.resolve([
                    "granted": false,
                    "status": "error",
                    "error": error.localizedDescription
                ])
            }
        }
    }
    
    @objc public func checkAuthorization(_ invoke: Invoke) throws {
        let status = resolvedAuthorizationStatus()
        invoke.resolve([
            "granted": status == .approved,
            "status": statusString(status)
        ])
    }
    
    // MARK: - Activity Picker
    
    @objc public func showActivityPicker(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ShowActivityPickerArgs.self)
        Task { @MainActor in
            guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let rootVC = windowScene.windows.first?.rootViewController else {
                invoke.resolve([
                    "cancelled": true,
                    "error": "No root view controller found"
                ])
                return
            }
            
            // Find the topmost presented view controller
            var topVC = rootVC
            while let presented = topVC.presentedViewController {
                topVC = presented
            }

            let hasExplicitInitialSelection =
                args.initialApplicationTokenData != nil || args.initialCategoryTokenData != nil
            let initialSelection = decodeSelection(
                applicationTokenData: args.initialApplicationTokenData,
                categoryTokenData: args.initialCategoryTokenData
            ) ?? (hasExplicitInitialSelection ? FamilyActivitySelection() : ScreentimePlugin.currentSelection)
            
            let pickerView = ActivityPickerView(
                initialSelection: initialSelection,
                onDone: { selection in
                    // Store the selection
                    ScreentimePlugin.currentSelection = selection

                    let encodedAppTokens = self.encodeApplicationTokens(selection.applicationTokens)
                    let encodedCategoryTokens = self.encodeCategoryTokens(selection.categoryTokens)
                    
                    // Dismiss the picker
                    topVC.dismiss(animated: true) {
                        var response: [String: Any] = [
                            "cancelled": false,
                            "applicationTokens": encodedAppTokens,
                            "categoryTokens": encodedCategoryTokens,
                            "applicationCount": selection.applicationTokens.count,
                            "categoryCount": selection.categoryTokens.count
                        ]
                        invoke.resolve(response)
                    }
                },
                onCancel: {
                    topVC.dismiss(animated: true) {
                        invoke.resolve([
                            "cancelled": true,
                            "applicationCount": 0,
                            "categoryCount": 0
                        ])
                    }
                }
            )
            
            let hostingController = UIHostingController(rootView: pickerView)
            hostingController.modalPresentationStyle = .pageSheet
            topVC.present(hostingController, animated: true)
        }
    }
    
    // MARK: - Website Blocking

    private func encodeApplicationTokens(_ tokens: Set<ApplicationToken>) -> [String] {
        tokens.compactMap { token in
            guard let data = try? JSONEncoder().encode(token) else {
                return nil
            }
            return data.base64EncodedString()
        }
    }

    private func encodeCategoryTokens(_ tokens: Set<ActivityCategoryToken>) -> [String] {
        tokens.compactMap { token in
            guard let data = try? JSONEncoder().encode(token) else {
                return nil
            }
            return data.base64EncodedString()
        }
    }

    private func decodeApplicationTokens(_ tokenData: [String]?) -> Set<ApplicationToken> {
        var tokens = Set<ApplicationToken>()
        for tokenString in tokenData ?? [] {
            if let data = Data(base64Encoded: tokenString),
               let token = try? JSONDecoder().decode(ApplicationToken.self, from: data) {
                tokens.insert(token)
            }
        }
        return tokens
    }

    private func decodeCategoryTokens(_ tokenData: [String]?) -> Set<ActivityCategoryToken> {
        var tokens = Set<ActivityCategoryToken>()
        for tokenString in tokenData ?? [] {
            if let data = Data(base64Encoded: tokenString),
               let token = try? JSONDecoder().decode(ActivityCategoryToken.self, from: data) {
                tokens.insert(token)
            }
        }
        return tokens
    }

    private func decodeSelection(
        applicationTokenData: [String]?,
        categoryTokenData: [String]?
    ) -> FamilyActivitySelection? {
        let appTokens = decodeApplicationTokens(applicationTokenData)
        let categoryTokens = decodeCategoryTokens(categoryTokenData)

        guard !appTokens.isEmpty || !categoryTokens.isEmpty else {
            return nil
        }

        var selection = FamilyActivitySelection()
        selection.applicationTokens = appTokens
        selection.categoryTokens = categoryTokens
        return selection
    }

    // MARK: - Shield UI snapshot (default / manual ManagedSettingsStore)

    /// Updates App Group `ShieldUISnapshot.manual` after the default store changes. Pass `nil` for an
    /// axis to leave that axis’s prior snapshot entries unchanged (e.g. `blockApps` does not clear domains).
    private func persistManualShieldSnapshot(
        replaceDomains: [String]?,
        replaceAppTokens: [String]?,
        replaceCategoryTokens: [String]?,
        blocklistEmoji: String? = nil,
        blocklistName: String? = nil,
        blocklistColorHex: String? = nil,
        blockStartMs: Double? = nil,
        blockEndMs: Double? = nil
    ) {
        let previous = SharedShieldSnapshotStore.load()
        let scheduleSection = previous?.schedule
        var domainMap = previous?.manual?.domainByNormalizedHost ?? [:]
        var appMap = previous?.manual?.appByTokenData ?? [:]
        var categoryMap = previous?.manual?.categoryByTokenData ?? [:]

        let nowMs = Date().timeIntervalSince1970 * 1000
        let startedMs = blockStartMs ?? nowMs
        let row = ShieldAttribution(
            sourceId: "manual",
            enforcementStartedAtMs: startedMs,
            blocklistEmoji: blocklistEmoji,
            blocklistName: blocklistName,
            blocklistColorHex: blocklistColorHex,
            blockStartedAtMs: startedMs,
            blockEndsAtMs: blockEndMs
        )

        if let hosts = replaceDomains {
            domainMap = [:]
            for raw in hosts {
                let key = ShieldSnapshotNormalization.normalizedWebHost(raw)
                domainMap[key] = row
            }
        }
        if let appTokens = replaceAppTokens {
            appMap = [:]
            for t in appTokens {
                appMap[t] = row
            }
        }
        if let categoryTokens = replaceCategoryTokens {
            categoryMap = [:]
            for t in categoryTokens {
                categoryMap[t] = row
            }
        }

        let manualSection: ShieldAttributionSection?
        if domainMap.isEmpty && appMap.isEmpty && categoryMap.isEmpty {
            manualSection = nil
        } else {
            manualSection = ShieldAttributionSection(
                domainByNormalizedHost: domainMap,
                appByTokenData: appMap,
                categoryByTokenData: categoryMap
            )
        }

        let snapshot = ShieldUISnapshot(
            schemaVersion: ShieldUISnapshot.currentSchemaVersion,
            updatedAtMs: nowMs,
            manual: manualSection,
            schedule: scheduleSection
        )
        SharedShieldSnapshotStore.save(snapshot)
    }
    
    /// Check if Screen Time authorization is granted
    private func isAuthorized() -> Bool {
        return resolvedAuthorizationStatus() == .approved
    }
    
    @objc public func blockWebsites(_ invoke: Invoke) throws {
        guard isAuthorized() else {
            invoke.resolve(["success": false, "error": "Screen Time authorization not granted"])
            return
        }
        let args = try invoke.parseArgs(BlockWebsitesArgs.self)
        
        // Convert domain strings to WebDomain objects
        // Screen Time API supports up to 50 domains per store
        let truncated = args.domains.count > 50
        let webDomains = Set(args.domains.prefix(50).map { WebDomain(domain: $0) })
        
        store.webContent.blockedByFilter = .specific(webDomains)

        persistManualShieldSnapshot(
            replaceDomains: Array(args.domains.prefix(50)),
            replaceAppTokens: nil,
            replaceCategoryTokens: nil
        )
        
        var response: [String: Any] = [
            "success": true,
            "blockedCount": webDomains.count
        ]
        if truncated {
            response["warning"] = "Only first 50 of \(args.domains.count) domains blocked (Screen Time API limit)"
        }
        invoke.resolve(response)
    }
    
    @objc public func unblockWebsites(_ invoke: Invoke) throws {
        store.webContent.blockedByFilter = nil
        persistManualShieldSnapshot(replaceDomains: [], replaceAppTokens: nil, replaceCategoryTokens: nil)
        invoke.resolve(["success": true])
    }
    
    // MARK: - App Blocking
    
    @objc public func blockApps(_ invoke: Invoke) throws {
        guard isAuthorized() else {
            invoke.resolve(["success": false, "error": "Screen Time authorization not granted"])
            return
        }
        let args = try invoke.parseArgs(BlockAppsForTokensArgs.self)
        
        // Decode ApplicationToken from base64-encoded data
        var tokens = Set<ApplicationToken>()
        var failedDecodes = 0
        for tokenString in args.tokenData {
            if let data = Data(base64Encoded: tokenString) {
                if let token = try? JSONDecoder().decode(ApplicationToken.self, from: data) {
                    tokens.insert(token)
                } else {
                    failedDecodes += 1
                }
            } else {
                failedDecodes += 1
            }
        }
        
        guard !tokens.isEmpty else {
            invoke.resolve([
                "success": false,
                "error": "No valid app tokens provided"
            ])
            return
        }
        
        store.shield.applications = tokens

        persistManualShieldSnapshot(
            replaceDomains: nil,
            replaceAppTokens: args.tokenData,
            replaceCategoryTokens: nil
        )
        
        var response: [String: Any] = [
            "success": true,
            "blockedCount": tokens.count
        ]
        if failedDecodes > 0 {
            response["warning"] = "Failed to decode \(failedDecodes) of \(args.tokenData.count) app token(s)"
        }
        invoke.resolve(response)
    }
    
    @objc public func unblockApps(_ invoke: Invoke) throws {
        store.shield.applications = nil
        persistManualShieldSnapshot(replaceDomains: nil, replaceAppTokens: [], replaceCategoryTokens: nil)
        invoke.resolve(["success": true])
    }
    
    // MARK: - Combined Block (websites + explicit app/category payloads)
    
    @objc public func startBlock(_ invoke: Invoke) throws {
        guard isAuthorized() else {
            invoke.resolve(["success": false, "error": "Screen Time authorization not granted"])
            return
        }
        let args = try invoke.parseArgs(StartBlockArgs.self)
        
        // Block websites (only when domains provided); for app-only blocks, clear web filter
        let truncated = args.domains.count > 50
        let webDomains = Set(args.domains.prefix(50).map { WebDomain(domain: $0) })
        if webDomains.isEmpty {
            store.webContent.blockedByFilter = nil
        } else {
            store.webContent.blockedByFilter = .specific(webDomains)
        }
        
        let appTokens = decodeApplicationTokens(args.appTokenData)
        let categoryTokens = decodeCategoryTokens(args.categoryTokenData)
        store.shield.applications = appTokens.isEmpty ? nil : appTokens
        store.shield.applicationCategories = categoryTokens.isEmpty ? nil : .specific(categoryTokens)
        
        // Persist current manual block state to App Group so extension can merge on resume/block-end
        let manualState = buildScheduleData(
            domains: args.domains,
            appTokenData: args.appTokenData,
            categoryTokenData: args.categoryTokenData,
            days: nil
        )
        SharedManualBlockStore.saveManualBlockState(manualState)

        persistManualShieldSnapshot(
            replaceDomains: Array(args.domains.prefix(50)),
            replaceAppTokens: args.appTokenData ?? [],
            replaceCategoryTokens: args.categoryTokenData ?? [],
            blocklistEmoji: args.blocklistEmoji,
            blocklistName: args.blocklistName,
            blocklistColorHex: args.blocklistColorHex,
            blockStartMs: args.blockStartMs,
            blockEndMs: args.blockEndMs
        )
        
        var response: [String: Any] = [
            "success": true,
            "websitesBlocked": webDomains.count,
            "appsBlocked": appTokens.count,
            "categoriesBlocked": categoryTokens.count
        ]
        if truncated {
            response["warning"] = "Only first 50 of \(args.domains.count) domains blocked (Screen Time API limit)"
        }
        invoke.resolve(response)
    }
    
    @objc public func clearBlock(_ invoke: Invoke) throws {
        // Clear the default store (manual blocks)
        store.webContent.blockedByFilter = nil
        store.shield.applications = nil
        store.shield.applicationCategories = nil
        store.clearAllSettings()
        
        // Clear manual block state in App Group so extension has no stale data
        SharedManualBlockStore.saveManualBlockState(ScheduleBlockData(domains: [], appTokenData: [], categoryTokenData: [], days: nil))

        persistManualShieldSnapshot(replaceDomains: [], replaceAppTokens: [], replaceCategoryTokens: [])
        
        // Also clear the named "schedule" store used by DeviceActivityMonitor
        // Since we use separate stores for manual vs schedule blocks, both
        // must be cleared for a complete "stop everything" action.
        let scheduleStore = ManagedSettingsStore(named: .init("schedule"))
        scheduleStore.clearAllSettings()
        ShieldScheduleSnapshotWriter.persistScheduleUnion(activeEntries: [])
        
        // Note: We intentionally do NOT clear currentSelection here.
        // The selection should persist so the user doesn't have to re-pick
        // apps for the next block cycle. This matches desktop behavior where
        // blocklists persist across block cycles.
        
        invoke.resolve(["success": true])
    }
    
    // MARK: - Scheduling
    
    @objc public func scheduleBlock(_ invoke: Invoke) throws {
        guard isAuthorized() else {
            invoke.resolve(["success": false, "error": "Screen Time authorization not granted"])
            return
        }
        let args = try invoke.parseArgs(ScheduleBlockArgs.self)
        let scheduleId = args.id ?? "default"
        
        let scheduleData = buildScheduleData(
            domains: args.domains,
            appTokenData: args.appTokenData,
            categoryTokenData: args.categoryTokenData,
            startHour: args.startHour,
            startMinute: args.startMinute,
            endHour: args.endHour,
            endMinute: args.endMinute
        )
        SharedScheduleStore.save(id: scheduleId, data: scheduleData)
        
        let schedule = buildDeviceActivitySchedule(
            startHour: args.startHour,
            startMinute: args.startMinute,
            endHour: args.endHour,
            endMinute: args.endMinute,
            repeats: true
        )
        
        let activityName = DeviceActivityName("redd-block-\(scheduleId)")
        
        do {
            try center.startMonitoring(activityName, during: schedule)
            invoke.resolve(["success": true, "scheduleId": scheduleId])
        } catch {
            invoke.resolve([
                "success": false,
                "error": error.localizedDescription
            ])
        }
    }
    
    /// Set multiple schedules at once (mirrors desktop set-schedules command).
    /// Replaces all existing schedules with the provided list.
    @objc public func setSchedules(_ invoke: Invoke) throws {
        guard isAuthorized() else {
            invoke.resolve(["success": false, "error": "Screen Time authorization not granted"])
            return
        }
        let args = try invoke.parseArgs(SetSchedulesArgs.self)
        NSLog("[ReDD Schedule] setSchedules called with %d entries", args.schedules.count)
        
        // Get current schedule IDs to determine which to remove
        let existingIds = Set(SharedScheduleStore.loadAll().keys)
        let newIds = Set(args.schedules.map { $0.id })
        
        // Remove schedules that are no longer in the list
        let removedIds = existingIds.subtracting(newIds)
        for id in removedIds {
            center.stopMonitoring([DeviceActivityName("redd-block-\(id)")])
            SharedScheduleStore.remove(id: id)
        }
        
        // If any schedules were removed, clear the named "schedule" ManagedSettingsStore.
        // The DeviceActivityMonitor extension writes blocks to this store when intervalDidStart
        // fires — those blocks persist at the OS level even after monitoring stops.
        // Remaining active schedules will re-apply their blocks when the system re-fires
        // intervalDidStart for their re-registered monitoring.
        if !removedIds.isEmpty {
            let scheduleStore = ManagedSettingsStore(named: .init("schedule"))
            scheduleStore.clearAllSettings()
        }
        
        // Add/update schedules
        var errors: [String] = []
        for entry in args.schedules {
            NSLog(
                "[ReDD Schedule] registering id=%@ start=%02d:%02d end=%02d:%02d repeats=%@ from=%@ until=%@ paused=%@ pauseEnd=%@ days=%@ domains=%d",
                entry.id,
                entry.startHour,
                entry.startMinute,
                entry.endHour,
                entry.endMinute,
                String(entry.repeats ?? true),
                entry.activeFromTimestampMs.map { String($0) } ?? "nil",
                entry.activeUntilTimestampMs.map { String($0) } ?? "nil",
                String(entry.isPaused ?? false),
                entry.pauseEndTimestampMs.map { String($0) } ?? "nil",
                String(describing: entry.days ?? []),
                entry.domains?.count ?? 0
            )
            let scheduleData = buildScheduleData(
                domains: entry.domains,
                appTokenData: entry.appTokenData,
                categoryTokenData: entry.categoryTokenData,
                days: entry.days,
                startHour: entry.startHour,
                startMinute: entry.startMinute,
                endHour: entry.endHour,
                endMinute: entry.endMinute,
                activeFromTimestampMs: entry.activeFromTimestampMs,
                activeUntilTimestampMs: entry.activeUntilTimestampMs,
                isPaused: entry.isPaused,
                pauseEndTimestampMs: entry.pauseEndTimestampMs,
                blocklistEmoji: entry.blocklistEmoji,
                blocklistName: entry.blocklistName,
                blocklistColorHex: entry.blocklistColorHex
            )
            SharedScheduleStore.save(id: entry.id, data: scheduleData)
            
            let schedule = buildDeviceActivitySchedule(
                startHour: entry.startHour,
                startMinute: entry.startMinute,
                endHour: entry.endHour,
                endMinute: entry.endMinute,
                repeats: entry.repeats ?? true
            )
            
            let activityName = DeviceActivityName("redd-block-\(entry.id)")
            
            do {
                try center.startMonitoring(activityName, during: schedule)
                NSLog("[ReDD Schedule] startMonitoring succeeded for %@", entry.id)
            } catch {
                NSLog("[ReDD Schedule] startMonitoring failed for %@: %@", entry.id, error.localizedDescription)
                errors.append("Schedule \(entry.id): \(error.localizedDescription)")
            }
        }
        
        reapplyActiveScheduleBlocksToStore(entries: args.schedules)
        
        if errors.isEmpty {
            invoke.resolve([
                "success": true,
                "scheduledCount": args.schedules.count
            ])
        } else {
            invoke.resolve([
                "success": false,
                "error": errors.joined(separator: "; ")
            ])
        }
    }
    
    @objc public func unscheduleBlock(_ invoke: Invoke) throws {
        // Try to parse args to check if a specific ID was provided
        let args = try? invoke.parseArgs(UnscheduleBlockArgs.self)
        
        if let specificId = args?.id {
            // Remove only the specified schedule
            center.stopMonitoring([DeviceActivityName("redd-block-\(specificId)")])
            SharedScheduleStore.remove(id: specificId)
        } else {
            // Remove all schedules
            let allIds = SharedScheduleStore.loadAll().keys
            let activityNames = allIds.map { DeviceActivityName("redd-block-\($0)") }
            if !activityNames.isEmpty {
                center.stopMonitoring(activityNames)
            }
            // Also stop the legacy name
            center.stopMonitoring([DeviceActivityName("redd-block-schedule")])
            SharedScheduleStore.clear()
        }
        
        // Clear the named "schedule" ManagedSettingsStore to remove OS-level blocks
        // that were applied by the DeviceActivityMonitor extension.
        let scheduleStore = ManagedSettingsStore(named: .init("schedule"))
        scheduleStore.clearAllSettings()
        ShieldScheduleSnapshotWriter.persistScheduleUnion(activeEntries: [])
        invoke.resolve(["success": true])
    }
    
    // MARK: - One-off DeviceActivity (pause resume / block end)
    
    /// Register a one-off DeviceActivity that starts at startTimestampMs and ends 15 minutes later.
    /// The extension will fire intervalDidStart at that time. Activity name e.g. "redd-block-resume-{blockId}" or "redd-block-end-{blockId}".
    @objc public func registerOneOffActivity(_ invoke: Invoke) throws {
        guard isAuthorized() else {
            invoke.resolve(["success": false, "error": "Screen Time authorization not granted"])
            return
        }
        let args = try invoke.parseArgs(RegisterOneOffActivityArgs.self)
        let startDate = Date(timeIntervalSince1970: args.startTimestampMs / 1000.0)
        let endDate = startDate.addingTimeInterval(15 * 60)
        let calendar = Calendar.current
        let crossesMidnight = !calendar.isDate(startDate, inSameDayAs: endDate)
        // Keep the existing same-day path unchanged. Only midnight-crossing one-offs
        // opt into explicit date components so 23:xx -> 00:xx registrations remain
        // anchored to the intended day boundary.
        let components: Set<Calendar.Component> = crossesMidnight
            ? [.year, .month, .day, .hour, .minute, .second]
            : [.hour, .minute, .second]
        let intervalStart = calendar.dateComponents(components, from: startDate)
        let intervalEnd = calendar.dateComponents(components, from: endDate)
        if crossesMidnight {
            NSLog(
                "[ReDD Schedule] registerOneOffActivity using date-aware midnight path name=%@ start=%@ end=%@",
                args.activityName,
                String(describing: intervalStart),
                String(describing: intervalEnd)
            )
        }
        let schedule = DeviceActivitySchedule(
            intervalStart: intervalStart,
            intervalEnd: intervalEnd,
            repeats: false
        )
        let activityName = DeviceActivityName(args.activityName)
        do {
            center.stopMonitoring([activityName])
            try center.startMonitoring(activityName, during: schedule)
            invoke.resolve(["success": true])
        } catch {
            invoke.resolve(["success": false, "error": error.localizedDescription])
        }
    }
    
    /// Save resume payload for a block so the extension can re-apply it when the one-off activity fires.
    @objc public func setResumePayload(_ invoke: Invoke) throws {
        guard isAuthorized() else {
            invoke.resolve(["success": false, "error": "Screen Time authorization not granted"])
            return
        }
        let args = try invoke.parseArgs(SetResumePayloadArgs.self)
        let payload = buildScheduleData(
            domains: args.domains,
            appTokenData: args.appTokenData,
            categoryTokenData: args.categoryTokenData,
            days: nil
        )
        SharedManualBlockStore.saveResumePayload(blockId: args.blockId, payload)
        invoke.resolve(["success": true])
    }
    
    /// Save state to apply when a block ends (effective state without this block) so extension can apply at endTime.
    @objc public func setBlockEndState(_ invoke: Invoke) throws {
        guard isAuthorized() else {
            invoke.resolve(["success": false, "error": "Screen Time authorization not granted"])
            return
        }
        let args = try invoke.parseArgs(SetBlockEndStateArgs.self)
        let payload = buildScheduleData(
            domains: args.domains,
            appTokenData: args.appTokenData,
            categoryTokenData: args.categoryTokenData,
            days: nil
        )
        SharedManualBlockStore.saveBlockEndState(blockId: args.blockId, payload)
        invoke.resolve(["success": true])
    }
    
    /// Build a ScheduleBlockData from explicit domains/app/category token payloads.
    /// Optional days (Mon=0 … Sun=6) and start/end times are stored for
    /// extension-side active-segment recomputation.
    private func buildScheduleData(
        domains: [String]?,
        appTokenData: [String]?,
        categoryTokenData: [String]?,
        days: [Int]? = nil,
        startHour: Int? = nil,
        startMinute: Int? = nil,
        endHour: Int? = nil,
        endMinute: Int? = nil,
        activeFromTimestampMs: Double? = nil,
        activeUntilTimestampMs: Double? = nil,
        isPaused: Bool? = nil,
        pauseEndTimestampMs: Double? = nil,
        blocklistEmoji: String? = nil,
        blocklistName: String? = nil,
        blocklistColorHex: String? = nil
    ) -> ScheduleBlockData {
        return ScheduleBlockData(
            domains: domains ?? [],
            appTokenData: appTokenData ?? [],
            categoryTokenData: categoryTokenData ?? [],
            days: days,
            startHour: startHour,
            startMinute: startMinute,
            endHour: endHour,
            endMinute: endMinute,
            activeFromTimestampMs: activeFromTimestampMs,
            activeUntilTimestampMs: activeUntilTimestampMs,
            isPaused: isPaused,
            pauseEndTimestampMs: pauseEndTimestampMs,
            blocklistEmoji: blocklistEmoji,
            blocklistName: blocklistName,
            blocklistColorHex: blocklistColorHex
        )
    }

    /// Apple enforces a 15-minute minimum DeviceActivity interval.
    /// For shorter schedules, pad the registered interval to 15 minutes and use
    /// warningTime so the extension gets a callback at the real end time.
    private func buildDeviceActivitySchedule(
        startHour: Int,
        startMinute: Int,
        endHour: Int,
        endMinute: Int,
        repeats: Bool
    ) -> DeviceActivitySchedule {
        let startComponents = DateComponents(hour: startHour, minute: startMinute)
        let actualDurationMinutes = durationMinutes(
            startHour: startHour,
            startMinute: startMinute,
            endHour: endHour,
            endMinute: endMinute
        )

        if actualDurationMinutes >= 15 {
            let endComponents = DateComponents(hour: endHour, minute: endMinute)
            return DeviceActivitySchedule(
                intervalStart: startComponents,
                intervalEnd: endComponents,
                repeats: repeats
            )
        }

        let paddedEndTotalMinutes = (startHour * 60 + startMinute + 15) % (24 * 60)
        let paddedEndComponents = DateComponents(
            hour: paddedEndTotalMinutes / 60,
            minute: paddedEndTotalMinutes % 60
        )
        let minutesBeforePaddedEnd = 15 - actualDurationMinutes

        NSLog(
            "[ReDD Schedule] padding short interval %02d:%02d-%02d:%02d to 15 minutes with warningTime=%d",
            startHour,
            startMinute,
            endHour,
            endMinute,
            minutesBeforePaddedEnd
        )

        return DeviceActivitySchedule(
            intervalStart: startComponents,
            intervalEnd: paddedEndComponents,
            repeats: repeats,
            warningTime: DateComponents(minute: minutesBeforePaddedEnd)
        )
    }

    private func durationMinutes(
        startHour: Int,
        startMinute: Int,
        endHour: Int,
        endMinute: Int
    ) -> Int {
        let startTotal = startHour * 60 + startMinute
        let endTotal = endHour * 60 + endMinute
        let wrapped = (endTotal - startTotal + 24 * 60) % (24 * 60)
        return wrapped == 0 ? 24 * 60 : wrapped
    }
    
    // MARK: - Re-apply active schedule blocks after clear (pause / setSchedules with removal)
    
    /// Current weekday in same encoding as frontend/extension: Mon=0 … Sun=6.
    private static func currentWeekdayMon0() -> Int {
        let weekday = Calendar.current.component(.weekday, from: Date())
        return (weekday - 2 + 7) % 7
    }

    private func isPauseActive(isPaused: Bool?, pauseEndTimestampMs: Double?, nowMs: Double) -> Bool {
        guard isPaused == true else { return false }
        guard let pauseEndTimestampMs else { return true }
        return pauseEndTimestampMs > nowMs
    }
    
    /// True if the segment's time window and day filter include the current time.
    private func isSegmentActiveNow(entry: ScheduleEntry) -> Bool {
        let now = Date()
        let nowMs = now.timeIntervalSince1970 * 1000.0
        if isPauseActive(isPaused: entry.isPaused, pauseEndTimestampMs: entry.pauseEndTimestampMs, nowMs: nowMs) {
            return false
        }
        if let activeFrom = entry.activeFromTimestampMs, nowMs < activeFrom {
            return false
        }
        if let activeUntil = entry.activeUntilTimestampMs, nowMs > activeUntil {
            return false
        }
        let today = Self.currentWeekdayMon0()
        if let days = entry.days, !days.isEmpty {
            if !days.contains(today) {
                return false
            }
        }
        let currentMins = Calendar.current.component(.hour, from: now) * 60 + Calendar.current.component(.minute, from: now)
        let startMins = entry.startHour * 60 + entry.startMinute
        let endMins = entry.endHour * 60 + entry.endMinute
        if endMins > startMins {
            return currentMins >= startMins && currentMins < endMins
        }
        let yesterdayDay = today == 0 ? 6 : today - 1
        if let days = entry.days, !days.isEmpty {
            let inEvening = days.contains(today) && currentMins >= startMins
            let inMorning = days.contains(yesterdayDay) && currentMins < endMins
            return inEvening || inMorning
        }
        return currentMins >= startMins || currentMins < endMins
    }
    
    /// After clearing the schedule store, re-apply the union of blocks for all remaining
    /// segments that are currently in their active time window.
    private func reapplyActiveScheduleBlocksToStore(entries: [ScheduleEntry]) {
        let now = Date()
        var allDomains = Set<WebDomain>()
        var allAppTokens = Set<ApplicationToken>()
        var allCategoryTokens = Set<ActivityCategoryToken>()
        var activePairs: [(String, ScheduleBlockData)] = []
        for entry in entries where isSegmentActiveNow(entry: entry) {
            guard let data = SharedScheduleStore.load(id: entry.id) else { continue }
            activePairs.append((entry.id, data))
            for domain in data.domains.prefix(50) {
                allDomains.insert(WebDomain(domain: domain))
            }
            for tokenString in data.appTokenData {
                if let tokenData = Data(base64Encoded: tokenString),
                   let token = try? JSONDecoder().decode(ApplicationToken.self, from: tokenData) {
                    allAppTokens.insert(token)
                }
            }
            for tokenString in data.categoryTokenData {
                if let tokenData = Data(base64Encoded: tokenString),
                   let token = try? JSONDecoder().decode(ActivityCategoryToken.self, from: tokenData) {
                    allCategoryTokens.insert(token)
                }
            }
        }
        let scheduleStore = ManagedSettingsStore(named: .init("schedule"))
        if allDomains.isEmpty && allAppTokens.isEmpty && allCategoryTokens.isEmpty {
            scheduleStore.clearAllSettings()
            ShieldScheduleSnapshotWriter.persistScheduleUnion(activeEntries: [], now: now)
            return
        }
        let domainArray = Array(allDomains.prefix(50))
        if domainArray.isEmpty {
            scheduleStore.webContent.blockedByFilter = nil
        } else {
            scheduleStore.webContent.blockedByFilter = .specific(Set(domainArray))
        }
        if allAppTokens.isEmpty {
            scheduleStore.shield.applications = nil
        } else {
            scheduleStore.shield.applications = allAppTokens
        }
        if allCategoryTokens.isEmpty {
            scheduleStore.shield.applicationCategories = nil
        } else {
            scheduleStore.shield.applicationCategories = .specific(allCategoryTokens)
        }
        ShieldScheduleSnapshotWriter.persistScheduleUnion(activeEntries: activePairs, now: now)
    }
    
    private func statusString(_ status: AuthorizationStatus) -> String {
        switch status {
        case .notDetermined:
            return "notDetermined"
        case .denied:
            return "denied"
        case .approved:
            return "approved"
        @unknown default:
            return "unknown"
        }
    }
}

// MARK: - Plugin Init

@_cdecl("init_plugin_screentime")
func initPlugin() -> Plugin {
    if #available(iOS 16.0, *) {
        return ScreentimePlugin()
    } else {
        // Fallback for iOS < 16 (shouldn't happen with deployment target 16.0)
        fatalError("Screen Time plugin requires iOS 16.0+")
    }
}
