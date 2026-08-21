import Foundation
import ManagedSettings

/// App Group identifier shared between the main app and the DeviceActivityMonitor extension.
let appGroupID = "group.com.reddblock"

/// Key used to store schedule block data in the shared UserDefaults.
let scheduleDataKey = "redd.scheduleBlockData"

/// Key used to store the multi-schedule dictionary.
let multiScheduleDataKey = "redd.multiScheduleData"

/// Key prefix for manual block state (current effective state for default store).
let manualBlockStateKey = "redd.manualBlockState"
/// Key for the manual-channel allowlist record: domains the user ALLOWED via
/// active allow-mode focus spaces. Kept separate from `manualBlockStateKey` so
/// one-off merge/subtract math never mixes blocked and allowed semantics.
let manualAllowlistStateKey = "redd.manualAllowlistState"
/// Key prefix for resume payloads: "redd.resumePayload.{blockId}"
let resumePayloadKeyPrefix = "redd.resumePayload."
/// Key prefix for block-end state: "redd.blockEndState.{blockId}"
let blockEndStateKeyPrefix = "redd.blockEndState."

/// Data model describing what to block during a scheduled time window.
/// Stored in the App Group's UserDefaults so the extension can read it.
struct ScheduleBlockData: Codable {
    /// Domain strings to block via WebContent filter
    let domains: [String]
    /// Base64-encoded ApplicationToken data
    let appTokenData: [String]
    /// Base64-encoded ActivityCategoryToken data
    let categoryTokenData: [String]
    /// Optional weekday filter: Mon=0 … Sun=6. If present and non-empty, extension only applies when current day is in this list.
    let days: [Int]?
    /// Optional start time for this schedule segment (hour/minute).
    /// Used by extension-side recompute logic for active schedule union.
    let startHour: Int?
    let startMinute: Int?
    /// Optional end time for this schedule segment (hour/minute).
    let endHour: Int?
    let endMinute: Int?
    /// Optional active window start/end (epoch milliseconds).
    /// Used to enforce non-repeating and date-limited schedules.
    let activeFromTimestampMs: Double?
    let activeUntilTimestampMs: Double?
    /// Optional pause state for schedule-backed entries.
    let isPaused: Bool?
    let pauseEndTimestampMs: Double?
    /// Optional blocklist presentation for shield snapshot (Pass 6).
    let blocklistEmoji: String?
    let blocklistName: String?
    let blocklistColorHex: String?
    /// "allowlist" when this entry's domains/tokens are ALLOWED items;
    /// nil/"blocklist" = blocked items (legacy semantics).
    let mode: String?

    /// True when this entry carries allowlist (allowed-items) semantics.
    var isAllowlist: Bool { mode == "allowlist" }

    init(
        domains: [String],
        appTokenData: [String],
        categoryTokenData: [String],
        days: [Int]?,
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
        blocklistColorHex: String? = nil,
        mode: String? = nil
    ) {
        self.domains = domains
        self.appTokenData = appTokenData
        self.categoryTokenData = categoryTokenData
        self.days = days
        self.startHour = startHour
        self.startMinute = startMinute
        self.endHour = endHour
        self.endMinute = endMinute
        self.activeFromTimestampMs = activeFromTimestampMs
        self.activeUntilTimestampMs = activeUntilTimestampMs
        self.isPaused = isPaused
        self.pauseEndTimestampMs = pauseEndTimestampMs
        self.blocklistEmoji = blocklistEmoji
        self.blocklistName = blocklistName
        self.blocklistColorHex = blocklistColorHex
        self.mode = mode
    }

    private enum CodingKeys: String, CodingKey {
        case domains
        case appTokenData
        case categoryTokenData
        case days
        case startHour
        case startMinute
        case endHour
        case endMinute
        case activeFromTimestampMs
        case activeUntilTimestampMs
        case isPaused
        case pauseEndTimestampMs
        case blocklistEmoji
        case blocklistName
        case blocklistColorHex
        case mode
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.domains = try container.decodeIfPresent([String].self, forKey: .domains) ?? []
        self.appTokenData = try container.decodeIfPresent([String].self, forKey: .appTokenData) ?? []
        self.categoryTokenData = try container.decodeIfPresent([String].self, forKey: .categoryTokenData) ?? []
        self.days = try container.decodeIfPresent([Int].self, forKey: .days)
        self.startHour = try container.decodeIfPresent(Int.self, forKey: .startHour)
        self.startMinute = try container.decodeIfPresent(Int.self, forKey: .startMinute)
        self.endHour = try container.decodeIfPresent(Int.self, forKey: .endHour)
        self.endMinute = try container.decodeIfPresent(Int.self, forKey: .endMinute)
        self.activeFromTimestampMs = try container.decodeIfPresent(Double.self, forKey: .activeFromTimestampMs)
        self.activeUntilTimestampMs = try container.decodeIfPresent(Double.self, forKey: .activeUntilTimestampMs)
        self.isPaused = try container.decodeIfPresent(Bool.self, forKey: .isPaused)
        self.pauseEndTimestampMs = try container.decodeIfPresent(Double.self, forKey: .pauseEndTimestampMs)
        self.blocklistEmoji = try container.decodeIfPresent(String.self, forKey: .blocklistEmoji)
        self.blocklistName = try container.decodeIfPresent(String.self, forKey: .blocklistName)
        self.blocklistColorHex = try container.decodeIfPresent(String.self, forKey: .blocklistColorHex)
        self.mode = try container.decodeIfPresent(String.self, forKey: .mode)
    }
}

/// Helper to read/write schedule data from the shared App Group container.
/// Supports both the legacy single-schedule key and the new multi-schedule dictionary.
struct SharedScheduleStore {
    private static var sharedDefaults: UserDefaults? {
        return UserDefaults(suiteName: appGroupID)
    }
    
    // MARK: - Multi-schedule API
    
    /// Save schedule data for a specific schedule ID.
    static func save(id: String, data: ScheduleBlockData) {
        var all = loadAll()
        all[id] = data
        saveAll(all)
    }
    
    /// Load schedule data for a specific schedule ID.
    static func load(id: String) -> ScheduleBlockData? {
        return loadAll()[id]
    }
    
    /// Load all schedule data entries.
    static func loadAll() -> [String: ScheduleBlockData] {
        guard let defaults = sharedDefaults,
              let data = defaults.data(forKey: multiScheduleDataKey) else {
            // Fall back to legacy single-schedule key for backward compatibility
            if let legacyData = loadLegacy() {
                return ["default": legacyData]
            }
            return [:]
        }
        return (try? JSONDecoder().decode([String: ScheduleBlockData].self, from: data)) ?? [:]
    }
    
    /// Remove a specific schedule by ID.
    static func remove(id: String) {
        var all = loadAll()
        all.removeValue(forKey: id)
        saveAll(all)
    }
    
    /// Remove all schedule data.
    static func clear() {
        sharedDefaults?.removeObject(forKey: multiScheduleDataKey)
        sharedDefaults?.removeObject(forKey: scheduleDataKey)
    }
    
    // MARK: - Legacy single-schedule API (backward compatibility)
    
    /// Save schedule block data using the legacy single-schedule key.
    static func save(_ data: ScheduleBlockData) {
        save(id: "default", data: data)
    }
    
    /// Load schedule block data from the legacy single-schedule key.
    static func load() -> ScheduleBlockData? {
        // Prefer multi-schedule, fall back to legacy
        if let multi = loadAll().first?.value {
            return multi
        }
        return loadLegacy()
    }
    
    // MARK: - Private
    
    private static func saveAll(_ schedules: [String: ScheduleBlockData]) {
        guard let defaults = sharedDefaults else { return }
        if let encoded = try? JSONEncoder().encode(schedules) {
            defaults.set(encoded, forKey: multiScheduleDataKey)
        }
    }
    
    private static func loadLegacy() -> ScheduleBlockData? {
        guard let defaults = sharedDefaults,
              let data = defaults.data(forKey: scheduleDataKey) else { return nil }
        return try? JSONDecoder().decode(ScheduleBlockData.self, from: data)
    }
}

// MARK: - Manual block state (for one-off resume/block-end)

/// Same shape as ScheduleBlockData: used for manual block state and resume/block-end payloads in App Group.
typealias ManualBlockStatePayload = ScheduleBlockData

/// Read/write manual block state and one-off payloads for DeviceActivityMonitor extension.
struct SharedManualBlockStore {
    private static var sharedDefaults: UserDefaults? {
        return UserDefaults(suiteName: appGroupID)
    }
    
    static func saveManualBlockState(_ data: ManualBlockStatePayload) {
        guard let defaults = sharedDefaults,
              let encoded = try? JSONEncoder().encode(data) else { return }
        defaults.set(encoded, forKey: manualBlockStateKey)
    }
    
    static func loadManualBlockState() -> ManualBlockStatePayload? {
        guard let defaults = sharedDefaults,
              let data = defaults.data(forKey: manualBlockStateKey) else { return nil }
        return try? JSONDecoder().decode(ManualBlockStatePayload.self, from: data)
    }
    
    static func saveResumePayload(blockId: String, _ data: ManualBlockStatePayload) {
        guard let defaults = sharedDefaults,
              let encoded = try? JSONEncoder().encode(data) else { return }
        defaults.set(encoded, forKey: resumePayloadKeyPrefix + blockId)
    }
    
    static func loadResumePayload(blockId: String) -> ManualBlockStatePayload? {
        guard let defaults = sharedDefaults,
              let data = defaults.data(forKey: resumePayloadKeyPrefix + blockId) else { return nil }
        return try? JSONDecoder().decode(ManualBlockStatePayload.self, from: data)
    }
    
    static func removeResumePayload(blockId: String) {
        sharedDefaults?.removeObject(forKey: resumePayloadKeyPrefix + blockId)
    }
    
    static func saveBlockEndState(blockId: String, _ data: ManualBlockStatePayload) {
        guard let defaults = sharedDefaults,
              let encoded = try? JSONEncoder().encode(data) else { return }
        defaults.set(encoded, forKey: blockEndStateKeyPrefix + blockId)
    }
    
    static func loadBlockEndState(blockId: String) -> ManualBlockStatePayload? {
        guard let defaults = sharedDefaults,
              let data = defaults.data(forKey: blockEndStateKeyPrefix + blockId) else { return nil }
        return try? JSONDecoder().decode(ManualBlockStatePayload.self, from: data)
    }
    
    static func removeBlockEndState(blockId: String) {
        sharedDefaults?.removeObject(forKey: blockEndStateKeyPrefix + blockId)
    }

    // MARK: - Manual allowlist record (allow-mode focus spaces)

    static func saveManualAllowlistState(_ data: ManualBlockStatePayload) {
        guard let defaults = sharedDefaults,
              let encoded = try? JSONEncoder().encode(data) else { return }
        defaults.set(encoded, forKey: manualAllowlistStateKey)
    }

    static func loadManualAllowlistState() -> ManualBlockStatePayload? {
        guard let defaults = sharedDefaults,
              let data = defaults.data(forKey: manualAllowlistStateKey) else { return nil }
        return try? JSONDecoder().decode(ManualBlockStatePayload.self, from: data)
    }

    static func clearManualAllowlistState() {
        sharedDefaults?.removeObject(forKey: manualAllowlistStateKey)
    }
}

// MARK: - Active-now predicate (shared by plugin and monitor extension)

extension ScheduleBlockData {
    /// True when this payload carries no enforceable content.
    var isEmptyPayload: Bool {
        domains.isEmpty && appTokenData.isEmpty && categoryTokenData.isEmpty
    }

    private static func currentWeekdayMon0(now: Date) -> Int {
        // Calendar.weekday: 1=Sun, 2=Mon, …, 7=Sat → Mon=0 … Sun=6
        let weekday = Calendar.current.component(.weekday, from: now)
        return (weekday - 2 + 7) % 7
    }

    private func isPauseActive(nowMs: Double) -> Bool {
        guard isPaused == true else { return false }
        guard let pauseEndTimestampMs = pauseEndTimestampMs else { return true }
        return pauseEndTimestampMs > nowMs
    }

    /// Whether this schedule entry should be enforcing at `now`. Handles pause
    /// state, active-window bounds, weekday filters, and cross-midnight segments.
    /// Legacy payloads without start/end times fall back to day-only matching.
    func isActiveNow(now: Date = Date()) -> Bool {
        let nowMs = now.timeIntervalSince1970 * 1000.0
        if isPauseActive(nowMs: nowMs) { return false }
        if let activeFrom = activeFromTimestampMs, nowMs < activeFrom { return false }
        if let activeUntil = activeUntilTimestampMs, nowMs > activeUntil { return false }

        let today = Self.currentWeekdayMon0(now: now)
        let currentMins = Calendar.current.component(.hour, from: now) * 60 + Calendar.current.component(.minute, from: now)

        let hasDayFilter = !(days?.isEmpty ?? true)
        let includesToday = days?.contains(today) ?? true

        guard let startHour = startHour,
              let startMinute = startMinute,
              let endHour = endHour,
              let endMinute = endMinute else {
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
        let includesYesterday = days?.contains(yesterday) ?? true

        if hasDayFilter {
            let inEveningPortion = includesToday && currentMins >= startMins
            let inMorningPortion = includesYesterday && currentMins < endMins
            return inEveningPortion || inMorningPortion
        }

        return currentMins >= startMins || currentMins < endMins
    }
}

// MARK: - Effective web policy (allowlist-aware, cross-channel)

/// Resolved website policy for one store. Mirrors the JS resolver in app.js:
/// concurrent allowlists union; explicit blocklist wins on overlap.
enum EffectiveWebPolicy {
    /// No active allowlist websites anywhere: each channel keeps its own
    /// blocked-domain `.specific(...)` set (legacy stacking behavior).
    case specificBlock
    /// At least one active allowlist has websites: block everything except
    /// the cross-channel allowed union minus explicitly blocked domains.
    case allExcept(Set<String>)
}

/// Resolved app-shield policy for one store. Mirrors EffectiveWebPolicy:
/// concurrent allowlists union; explicit blocklist wins on overlap.
enum EffectiveAppPolicy {
    /// No active allowlist app tokens anywhere: each channel keeps its own
    /// blocked-token specific shields (legacy stacking behavior).
    case specificBlock
    /// At least one active allowlist has app tokens: shield every app except
    /// the cross-channel allowed union minus explicitly blocked tokens.
    /// Values are base64-encoded ApplicationToken data.
    case allExcept(Set<String>)
}

enum IOSPolicyResolver {
    /// Every currently-active enforcement payload across BOTH channels:
    /// manual blocked record, manual allowlist record, and active schedule entries.
    static func allActiveEntries(now: Date = Date()) -> [ScheduleBlockData] {
        var entries: [ScheduleBlockData] = []
        if let manual = SharedManualBlockStore.loadManualBlockState(), !manual.isEmptyPayload {
            entries.append(manual)
        }
        if let manualAllow = SharedManualBlockStore.loadManualAllowlistState(), !manualAllow.isEmptyPayload {
            entries.append(manualAllow)
        }
        for (_, data) in SharedScheduleStore.loadAll() where data.isActiveNow(now: now) {
            entries.append(data)
        }
        return entries
    }

    static func effectiveWebPolicy(entries: [ScheduleBlockData]) -> EffectiveWebPolicy {
        var blocked = Set<String>()
        var allowed = Set<String>()
        for entry in entries {
            if entry.isAllowlist {
                allowed.formUnion(entry.domains)
            } else {
                blocked.formUnion(entry.domains)
            }
        }
        if allowed.isEmpty { return .specificBlock }
        return .allExcept(allowed.subtracting(blocked))
    }

    static func effectiveAppPolicy(entries: [ScheduleBlockData]) -> EffectiveAppPolicy {
        var blocked = Set<String>()
        var allowed = Set<String>()
        for entry in entries {
            if entry.isAllowlist {
                allowed.formUnion(entry.appTokenData)
            } else {
                blocked.formUnion(entry.appTokenData)
            }
        }
        if allowed.isEmpty { return .specificBlock }
        return .allExcept(allowed.subtracting(blocked))
    }
}

/// Applies the effective web policy to BOTH ManagedSettingsStore channels from
/// current App Group state. Called by every writer (plugin start/clear/reapply,
/// extension interval events and one-offs) so the web filter is always derived
/// state and the two channels can never drift.
///
/// Why both stores: ManagedSettings stacks restrictively — a store can never
/// make another store less restrictive. Two different `.all(except:)` sets
/// would enforce their INTERSECTION, so when allowlists are active in both
/// channels each store must carry the same cross-channel exception union.
enum IOSWebPolicyApplier {
    /// Apple caps `.all(except:)` at 50 exception domains per store.
    static let exceptionLimit = 50

    static func reapplyWebPolicy(now: Date = Date()) {
        let manualStore = ManagedSettingsStore()
        let scheduleStore = ManagedSettingsStore(named: .init("schedule"))
        let entries = IOSPolicyResolver.allActiveEntries(now: now)

        switch IOSPolicyResolver.effectiveWebPolicy(entries: entries) {
        case .specificBlock:
            // Legacy behavior, per channel: own blocked domains only.
            let manualDomains = SharedManualBlockStore.loadManualBlockState()?.domains ?? []
            let manualWeb = Set(manualDomains.prefix(50).map { WebDomain(domain: $0) })
            manualStore.webContent.blockedByFilter = manualWeb.isEmpty ? nil : .specific(manualWeb)

            var scheduleWeb = Set<WebDomain>()
            for (_, data) in SharedScheduleStore.loadAll()
            where data.isActiveNow(now: now) && !data.isAllowlist {
                for domain in data.domains.prefix(50) {
                    scheduleWeb.insert(WebDomain(domain: domain))
                }
            }
            scheduleStore.webContent.blockedByFilter = scheduleWeb.isEmpty ? nil : .specific(scheduleWeb)

        case .allExcept(let allowed):
            var exceptions = allowed
            if exceptions.count > exceptionLimit {
                // Fail-safe direction for a blocker: over-block deterministically
                // rather than drop the allowlist. JS validation prevents reaching
                // this state; this is a belt-and-braces guard.
                NSLog(
                    "[ReDD Allowlist] exception set of %d exceeds the 50-domain Screen Time cap; clamping (over-blocking)",
                    exceptions.count
                )
                exceptions = Set(exceptions.sorted().prefix(exceptionLimit))
            }
            let webExceptions = Set(exceptions.map { WebDomain(domain: $0) })
            // A store whose own channel has no active allowlist keeps its legacy
            // .specific set; a channel WITH an allowlist carries the full
            // cross-channel exception union (see enum doc above).
            let manualHasAllowlist = !(SharedManualBlockStore.loadManualAllowlistState()?.domains.isEmpty ?? true)
            let scheduleHasAllowlist = SharedScheduleStore.loadAll().contains {
                $0.value.isActiveNow(now: now) && $0.value.isAllowlist && !$0.value.domains.isEmpty
            }

            if manualHasAllowlist {
                manualStore.webContent.blockedByFilter = .all(except: webExceptions)
            } else {
                let manualDomains = SharedManualBlockStore.loadManualBlockState()?.domains ?? []
                let manualWeb = Set(manualDomains.prefix(50).map { WebDomain(domain: $0) })
                manualStore.webContent.blockedByFilter = manualWeb.isEmpty ? nil : .specific(manualWeb)
            }

            if scheduleHasAllowlist {
                scheduleStore.webContent.blockedByFilter = .all(except: webExceptions)
            } else {
                var scheduleWeb = Set<WebDomain>()
                for (_, data) in SharedScheduleStore.loadAll()
                where data.isActiveNow(now: now) && !data.isAllowlist {
                    for domain in data.domains.prefix(50) {
                        scheduleWeb.insert(WebDomain(domain: domain))
                    }
                }
                scheduleStore.webContent.blockedByFilter = scheduleWeb.isEmpty ? nil : .specific(scheduleWeb)
            }
        }
    }
}

/// Applies the effective app policy to BOTH ManagedSettingsStore channels from
/// current App Group state — the app-shield counterpart to IOSWebPolicyApplier
/// (see its doc for why both stores must carry the same exception union).
/// Category tokens only shield in specific-block mode: Apple's `.all(except:)`
/// takes application tokens, and category shields are redundant once every
/// app is shielded.
enum IOSAppPolicyApplier {
    /// Apple caps `.all(except:)` at 50 exception tokens per store.
    static let exceptionLimit = 50

    private static func decodeAppTokens(_ tokenData: [String]) -> Set<ApplicationToken> {
        var tokens: [ApplicationToken] = []
        for tokenString in tokenData {
            if let data = Data(base64Encoded: tokenString),
               let token = try? JSONDecoder().decode(ApplicationToken.self, from: data) {
                tokens.append(token)
            }
        }
        if #available(iOS 26.5, *), !tokens.isEmpty {
            do {
                var refreshedTokens = tokens
                try ManagedSettingsStore.refresh(&refreshedTokens)
                if refreshedTokens.count == tokens.count {
                    tokens = refreshedTokens
                } else {
                    NSLog("[ReDD Screen Time] Application token refresh dropped saved tokens; keeping originals")
                }
            } catch {
                // Keep the original decoded tokens as a best-effort shield.
                // The main app marks this selection for picker reselection.
                NSLog("[ReDD Screen Time] Application token refresh failed: %@", error.localizedDescription)
            }
        }
        return Set(tokens)
    }

    private static func decodeCategoryTokens(_ tokenData: [String]) -> Set<ActivityCategoryToken> {
        var tokens: [ActivityCategoryToken] = []
        for tokenString in tokenData {
            if let data = Data(base64Encoded: tokenString),
               let token = try? JSONDecoder().decode(ActivityCategoryToken.self, from: data) {
                tokens.append(token)
            }
        }
        if #available(iOS 26.5, *), !tokens.isEmpty {
            do {
                var refreshedTokens = tokens
                try ManagedSettingsStore.refresh(&refreshedTokens)
                if refreshedTokens.count == tokens.count {
                    tokens = refreshedTokens
                } else {
                    NSLog("[ReDD Screen Time] Category token refresh dropped saved tokens; keeping originals")
                }
            } catch {
                NSLog("[ReDD Screen Time] Category token refresh failed: %@", error.localizedDescription)
            }
        }
        return Set(tokens)
    }

    /// Legacy behavior for the manual channel: shields from the manual blocked record.
    private static func applyLegacyManualShields(to store: ManagedSettingsStore) {
        let manual = SharedManualBlockStore.loadManualBlockState()
        let appTokens = decodeAppTokens(manual?.appTokenData ?? [])
        let categoryTokens = decodeCategoryTokens(manual?.categoryTokenData ?? [])
        store.shield.applications = appTokens.isEmpty ? nil : appTokens
        store.shield.applicationCategories = categoryTokens.isEmpty ? nil : .specific(categoryTokens)
    }

    /// Legacy behavior for the schedule channel: shields from the union of
    /// active blocklist schedule entries.
    private static func applyLegacyScheduleShields(to store: ManagedSettingsStore, now: Date) {
        var appTokens = Set<ApplicationToken>()
        var categoryTokens = Set<ActivityCategoryToken>()
        for (_, data) in SharedScheduleStore.loadAll()
        where data.isActiveNow(now: now) && !data.isAllowlist {
            appTokens.formUnion(decodeAppTokens(data.appTokenData))
            categoryTokens.formUnion(decodeCategoryTokens(data.categoryTokenData))
        }
        store.shield.applications = appTokens.isEmpty ? nil : appTokens
        store.shield.applicationCategories = categoryTokens.isEmpty ? nil : .specific(categoryTokens)
    }

    static func reapplyAppPolicy(now: Date = Date()) {
        let manualStore = ManagedSettingsStore()
        let scheduleStore = ManagedSettingsStore(named: .init("schedule"))
        let entries = IOSPolicyResolver.allActiveEntries(now: now)

        switch IOSPolicyResolver.effectiveAppPolicy(entries: entries) {
        case .specificBlock:
            applyLegacyManualShields(to: manualStore)
            applyLegacyScheduleShields(to: scheduleStore, now: now)

        case .allExcept(let allowedTokenData):
            var exceptionData = allowedTokenData
            if exceptionData.count > exceptionLimit {
                // Fail-safe direction for a blocker: over-block deterministically
                // rather than drop the allowlist. JS validation prevents reaching
                // this state; this is a belt-and-braces guard.
                NSLog(
                    "[ReDD Allowlist] exception set of %d exceeds the 50-app Screen Time cap; clamping (over-blocking)",
                    exceptionData.count
                )
                exceptionData = Set(exceptionData.sorted().prefix(exceptionLimit))
            }
            let exceptions = decodeAppTokens(Array(exceptionData))
            // A channel with no active app allowlist keeps its legacy specific
            // shields; a channel WITH one carries the full cross-channel
            // exception union (see IOSWebPolicyApplier doc).
            let manualHasAllowlist = !(SharedManualBlockStore.loadManualAllowlistState()?.appTokenData.isEmpty ?? true)
            let scheduleHasAllowlist = SharedScheduleStore.loadAll().contains {
                $0.value.isActiveNow(now: now) && $0.value.isAllowlist && !$0.value.appTokenData.isEmpty
            }

            if manualHasAllowlist {
                // Per Apple DTS: one store, one policy — explicit application
                // shields would fight the exception list.
                manualStore.shield.applications = nil
                manualStore.shield.applicationCategories = .all(except: exceptions)
            } else {
                applyLegacyManualShields(to: manualStore)
            }

            if scheduleHasAllowlist {
                scheduleStore.shield.applications = nil
                scheduleStore.shield.applicationCategories = .all(except: exceptions)
            } else {
                applyLegacyScheduleShields(to: scheduleStore, now: now)
            }
        }
    }
}
