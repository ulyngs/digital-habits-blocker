package net.kollnig.reddblockandroid.data

import java.time.DayOfWeek
import java.time.LocalTime

data class Schedule(
    val id: String,
    val name: String,
    val isEnabled: Boolean = true,
    val timing: ScheduleTiming,
    val blockedApps: List<String> = emptyList(),
    val blockedWebsites: List<String> = emptyList(),
    val frictionWordCount: Int = 15,
    val autoReenableMinutes: Int = 1440, // default 24 hours; 0 = stays disabled
    val disabledUntil: Long? = null
)

data class ScheduleTiming(
    val type: ScheduleType,
    val timeHour: Int? = null,
    val timeMinute: Int? = null,
    val endTimeHour: Int? = null,
    val endTimeMinute: Int? = null,
    val daysOfWeek: Set<DayOfWeek> = emptySet(),
    val isRecurring: Boolean = true
) {
    enum class ScheduleType {
        DAILY,
        WEEKLY,
        MANUAL
    }

    val time: LocalTime?
        get() = if (timeHour != null && timeMinute != null) {
            LocalTime.of(timeHour, timeMinute)
        } else null

    val endTime: LocalTime?
        get() = if (endTimeHour != null && endTimeMinute != null) {
            LocalTime.of(endTimeHour, endTimeMinute)
        } else null
}
