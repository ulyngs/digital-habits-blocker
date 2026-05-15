import DeviceActivity
import ManagedSettings
import Foundation

/// DeviceActivityMonitor extension that applies/clears blocks when scheduled time windows start/end.
/// This runs as a separate process — it does NOT have access to the main app's memory.
/// It reads schedule data from the shared App Group UserDefaults.
@available(iOS 16.0, *)
class ReddBlockMonitor: DeviceActivityMonitor {
    
    /// Use a NAMED store for schedule-based blocks so they don't interfere
    /// with manual blocks in the default ManagedSettingsStore.
    /// The ScreentimePlugin uses ManagedSettingsStore() (default) for manual
    /// blocks — these two stores stack independently at the OS level.
    private let store = ManagedSettingsStore(named: .init("schedule"))
    
    /// Default store for manual blocks (resume/block-end one-offs write here).
    private let defaultStore = ManagedSettingsStore()
    
    /// Called by the system when a scheduled DeviceActivity interval starts.
    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        
        let raw = activity.rawValue
        NSLog("[ReDD Schedule] intervalDidStart raw=%@", raw)

        if raw.hasPrefix("redd-schedule-resume-") {
            recomputeActiveScheduleUnion()
            return
        }
        
        // One-off: pause resume — merge manual state + resume payload and apply to default store
        if raw.hasPrefix("redd-block-resume-") {
            let blockId = String(raw.dropFirst("redd-block-resume-".count))
            handleResumeOneOff(blockId: blockId)
            return
        }
        
        // One-off: block end — load current manual state, subtract this block's payload, apply, write back (Option B)
        if raw.hasPrefix("redd-block-end-") {
            let blockId = String(raw.dropFirst("redd-block-end-".count))
            handleBlockEndOneOff(blockId: blockId)
            return
        }
        
        // Regular schedule segment
        recomputeActiveScheduleUnion()
    }
    
    /// Handle one-off resume: load manual state + resume payload, merge, apply to default store, write back to App Group, remove payload.
    private func handleResumeOneOff(blockId: String) {
        guard let resumePayload = SharedManualBlockStore.loadResumePayload(blockId: blockId) else {
            return
        }
        let base = SharedManualBlockStore.loadManualBlockState()
        let merged = mergePayloads(base: base, extra: resumePayload)
        applyToDefaultStore(from: merged)
        SharedManualBlockStore.saveManualBlockState(merged)
        SharedManualBlockStore.removeResumePayload(blockId: blockId)
    }
    
    /// Handle one-off block end (Option B): load current manual state, subtract this block's payload, apply to default store, write back to App Group.
    private func handleBlockEndOneOff(blockId: String) {
        guard let toRemove = SharedManualBlockStore.loadBlockEndState(blockId: blockId) else {
            return
        }
        let current = SharedManualBlockStore.loadManualBlockState()
        let emptyPayload = ManualBlockStatePayload(domains: [], appTokenData: [], categoryTokenData: [], days: nil)
        let newState = subtractPayloads(current: current ?? emptyPayload, subtract: toRemove)
        applyToDefaultStore(from: newState)
        SharedManualBlockStore.saveManualBlockState(newState)
        SharedManualBlockStore.removeBlockEndState(blockId: blockId)
    }
    
    /// Subtract "to remove" payload from current (set difference for domains; filter out matching app/category tokens).
    private func subtractPayloads(current: ManualBlockStatePayload, subtract: ManualBlockStatePayload) -> ManualBlockStatePayload {
        let domainSet = Set(current.domains).subtracting(subtract.domains)
        let subtractAppSet = Set(subtract.appTokenData)
        let appTokenData = current.appTokenData.filter { !subtractAppSet.contains($0) }
        let subtractCategorySet = Set(subtract.categoryTokenData)
        let categoryTokenData = current.categoryTokenData.filter { !subtractCategorySet.contains($0) }
        return ManualBlockStatePayload(
            domains: Array(domainSet),
            appTokenData: appTokenData,
            categoryTokenData: categoryTokenData,
            days: nil
        )
    }
    
    /// Merge two payloads (union of domains, appTokenData, categoryTokenData).
    private func mergePayloads(base: ManualBlockStatePayload?, extra: ManualBlockStatePayload) -> ManualBlockStatePayload {
        let domains = Set(base?.domains ?? []).union(extra.domains)
        var appTokenData = base?.appTokenData ?? []
        for s in extra.appTokenData where !appTokenData.contains(s) {
            appTokenData.append(s)
        }
        var categoryTokenData = base?.categoryTokenData ?? []
        for s in extra.categoryTokenData where !categoryTokenData.contains(s) {
            categoryTokenData.append(s)
        }
        return ManualBlockStatePayload(
            domains: Array(domains),
            appTokenData: appTokenData,
            categoryTokenData: categoryTokenData,
            days: nil
        )
    }
    
    /// Apply payload to the default (manual) store.
    private func applyToDefaultStore(from data: ManualBlockStatePayload) {
        if data.domains.isEmpty && data.appTokenData.isEmpty && data.categoryTokenData.isEmpty {
            defaultStore.webContent.blockedByFilter = nil
            defaultStore.shield.applications = nil
            defaultStore.shield.applicationCategories = nil
            defaultStore.clearAllSettings()
            return
        }
        if !data.domains.isEmpty {
            let webDomains = Set(data.domains.prefix(50).map { WebDomain(domain: $0) })
            defaultStore.webContent.blockedByFilter = .specific(webDomains)
        } else {
            defaultStore.webContent.blockedByFilter = nil
        }
        var appTokens = Set<ApplicationToken>()
        for tokenString in data.appTokenData {
            if let tokenData = Data(base64Encoded: tokenString),
               let token = try? JSONDecoder().decode(ApplicationToken.self, from: tokenData) {
                appTokens.insert(token)
            }
        }
        if appTokens.isEmpty {
            defaultStore.shield.applications = nil
        } else {
            defaultStore.shield.applications = appTokens
        }
        var categoryTokens = Set<ActivityCategoryToken>()
        for tokenString in data.categoryTokenData {
            if let tokenData = Data(base64Encoded: tokenString),
               let token = try? JSONDecoder().decode(ActivityCategoryToken.self, from: tokenData) {
                categoryTokens.insert(token)
            }
        }
        if categoryTokens.isEmpty {
            defaultStore.shield.applicationCategories = nil
        } else {
            defaultStore.shield.applicationCategories = .specific(categoryTokens)
        }
    }
    
    /// Called by the system when a scheduled DeviceActivity interval ends.
    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        
        let raw = activity.rawValue
        NSLog("[ReDD Schedule] intervalDidEnd raw=%@", raw)
        // One-off resume/block-end: we only care about intervalDidStart; do not clear default store when interval ends
        if raw.hasPrefix("redd-schedule-resume-") || raw.hasPrefix("redd-block-resume-") || raw.hasPrefix("redd-block-end-") {
            return
        }
        
        recomputeActiveScheduleUnion()
    }

    /// Called before a padded short interval ends. We use this to recompute at
    /// the schedule's real end time when the registered DeviceActivity interval
    /// had to be stretched to Apple's 15-minute minimum.
    override func intervalWillEndWarning(for activity: DeviceActivityName) {
        super.intervalWillEndWarning(for: activity)

        let raw = activity.rawValue
        NSLog("[ReDD Schedule] intervalWillEndWarning raw=%@", raw)
        if raw.hasPrefix("redd-schedule-resume-") || raw.hasPrefix("redd-block-resume-") || raw.hasPrefix("redd-block-end-") {
            return
        }

        recomputeActiveScheduleUnion()
    }
    
    // MARK: - Helpers
    
    /// Current weekday in same encoding as frontend/helper: Mon=0 … Sun=6.
    private static func currentWeekdayMon0() -> Int {
        // Calendar.weekday: 1=Sun, 2=Mon, …, 7=Sat
        let weekday = Calendar.current.component(.weekday, from: Date())
        return (weekday - 2 + 7) % 7
    }

    private func isPauseActive(_ data: ScheduleBlockData, nowMs: Double) -> Bool {
        guard data.isPaused == true else { return false }
        guard let pauseEndTimestampMs = data.pauseEndTimestampMs else { return true }
        return pauseEndTimestampMs > nowMs
    }
    
    /// Recompute and apply the union of all schedule entries that are active at "now".
    /// This prevents stale shields and keeps overlap handling consistent on start/end events.
    private func recomputeActiveScheduleUnion(now: Date = Date()) {
        let allSchedules = SharedScheduleStore.loadAll()
        NSLog("[ReDD Schedule] recomputeActiveScheduleUnion schedules=%d", allSchedules.count)
        var activeDomains = Set<WebDomain>()
        var activeAppTokens = Set<ApplicationToken>()
        var activeCategoryTokens = Set<ActivityCategoryToken>()
        var activePairs: [(String, ScheduleBlockData)] = []

        for (id, data) in allSchedules where isScheduleDataActiveNow(data, now: now) {
            activePairs.append((id, data))
            NSLog("[ReDD Schedule] active schedule id=%@ domains=%d apps=%d categories=%d", id, data.domains.count, data.appTokenData.count, data.categoryTokenData.count)
            for domain in data.domains.prefix(50) {
                activeDomains.insert(WebDomain(domain: domain))
            }
            for tokenString in data.appTokenData {
                if let tokenData = Data(base64Encoded: tokenString),
                   let token = try? JSONDecoder().decode(ApplicationToken.self, from: tokenData) {
                    activeAppTokens.insert(token)
                }
            }
            for tokenString in data.categoryTokenData {
                if let tokenData = Data(base64Encoded: tokenString),
                   let token = try? JSONDecoder().decode(ActivityCategoryToken.self, from: tokenData) {
                    activeCategoryTokens.insert(token)
                }
            }
        }

        applyScheduleUnion(
            domains: activeDomains,
            appTokens: activeAppTokens,
            categoryTokens: activeCategoryTokens
        )
        ShieldScheduleSnapshotWriter.persistScheduleUnion(activeEntries: activePairs, now: now)
    }
    
    /// Apply schedule union and clear stale settings when a component is empty.
    private func applyScheduleUnion(
        domains: Set<WebDomain>,
        appTokens: Set<ApplicationToken>,
        categoryTokens: Set<ActivityCategoryToken>
    ) {
        NSLog("[ReDD Schedule] applyScheduleUnion domains=%d apps=%d categories=%d", domains.count, appTokens.count, categoryTokens.count)
        store.webContent.blockedByFilter = domains.isEmpty ? nil : .specific(domains)
        store.shield.applications = appTokens.isEmpty ? nil : appTokens
        store.shield.applicationCategories = categoryTokens.isEmpty ? nil : .specific(categoryTokens)

        if domains.isEmpty && appTokens.isEmpty && categoryTokens.isEmpty {
            store.clearAllSettings()
        }
    }

    /// Evaluate whether a persisted schedule entry should be active now.
    /// If start/end times are missing (legacy payload), fall back to day-only matching.
    private func isScheduleDataActiveNow(_ data: ScheduleBlockData, now: Date = Date()) -> Bool {
        let nowMs = now.timeIntervalSince1970 * 1000.0
        if isPauseActive(data, nowMs: nowMs) {
            NSLog(
                "[ReDD Schedule] inactive: paused now=%f pauseEnd=%@",
                nowMs,
                data.pauseEndTimestampMs.map { String($0) } ?? "nil"
            )
            return false
        }
        if let activeFrom = data.activeFromTimestampMs, nowMs < activeFrom {
            NSLog("[ReDD Schedule] inactive: before activeFrom now=%f activeFrom=%f", nowMs, activeFrom)
            return false
        }
        if let activeUntil = data.activeUntilTimestampMs, nowMs > activeUntil {
            NSLog("[ReDD Schedule] inactive: after activeUntil now=%f activeUntil=%f", nowMs, activeUntil)
            return false
        }

        let today = Self.currentWeekdayMon0()
        let currentMins = Calendar.current.component(.hour, from: now) * 60 + Calendar.current.component(.minute, from: now)

        let hasDayFilter = !(data.days?.isEmpty ?? true)
        let includesToday = data.days?.contains(today) ?? true

        guard let startHour = data.startHour,
              let startMinute = data.startMinute,
              let endHour = data.endHour,
              let endMinute = data.endMinute else {
            // Legacy schedule payload: evaluate by weekday only.
            return !hasDayFilter || includesToday
        }

        let startMins = startHour * 60 + startMinute
        let endMins = endHour * 60 + endMinute

        if endMins > startMins {
            if hasDayFilter && !includesToday { return false }
            return currentMins >= startMins && currentMins < endMins
        }

        // Cross-midnight segment
        let yesterday = today == 0 ? 6 : today - 1
        let includesYesterday = data.days?.contains(yesterday) ?? true

        if hasDayFilter {
            let inEveningPortion = includesToday && currentMins >= startMins
            let inMorningPortion = includesYesterday && currentMins < endMins
            return inEveningPortion || inMorningPortion
        }

        return currentMins >= startMins || currentMins < endMins
    }
    
    /// Extract a schedule ID from a DeviceActivityName.
    /// Activity names follow the format "redd-block-{id}".
    /// Falls back to "default" for the legacy "redd-block-schedule" name.
    private func extractScheduleId(from activity: DeviceActivityName) -> String {
        let raw = activity.rawValue
        if raw.hasPrefix("redd-block-") {
            let id = String(raw.dropFirst("redd-block-".count))
            return id.isEmpty ? "default" : id
        }
        // Legacy name
        return "default"
    }
}
