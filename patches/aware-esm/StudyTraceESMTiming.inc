// Included inside ESMScheduleManager's implementation by apply_aware_timing_patch.rb.
// Keep this outside Pods so CocoaPods cannot discard the timing policy.

+ (NSDate *)studytraceDeadlineForDelivery:(NSDate *)delivery expirationMinutes:(NSInteger)minutes {
    if (minutes > 0) return [delivery dateByAddingTimeInterval:minutes * 60.0];
    NSCalendar *calendar = [NSCalendar currentCalendar];
    return [calendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:[calendar startOfDayForDate:delivery] options:0];
}

+ (BOOL)studytraceIsOpenWithDelivery:(NSDate *)delivery expirationMinutes:(NSInteger)minutes now:(NSDate *)now {
    return [now compare:delivery] != NSOrderedAscending &&
        [now compare:[self studytraceDeadlineForDelivery:delivery expirationMinutes:minutes]] == NSOrderedAscending;
}

+ (NSInteger)studytraceOffsetForSeed:(NSString *)seed range:(NSInteger)range {
    if (range <= 0) return 0;
    // FNV-1a is stable across processes. NSString.hash is not a persistent seed.
    uint64_t hash = UINT64_C(14695981039346656037);
    NSData *data = [seed dataUsingEncoding:NSUTF8StringEncoding];
    const uint8_t *bytes = data.bytes;
    for (NSUInteger i = 0; i < data.length; i++) { hash ^= bytes[i]; hash *= UINT64_C(1099511628211); }
    return (NSInteger)(hash % (uint64_t)(range * 2 + 1)) - range;
}

+ (BOOL)studytraceIsWithinWindow:(NSDate *)date start:(NSString *)start end:(NSString *)end {
    if (start.length == 0 || end.length == 0) return YES;
    NSArray *a = [start componentsSeparatedByString:@":"];
    NSArray *b = [end componentsSeparatedByString:@":"];
    if (a.count != 2 || b.count != 2) return NO;
    NSDateComponents *clock = [[NSCalendar currentCalendar] components:NSCalendarUnitHour|NSCalendarUnitMinute|NSCalendarUnitSecond fromDate:date];
    NSInteger seconds = clock.hour * 3600 + clock.minute * 60 + clock.second;
    return seconds >= [a[0] integerValue] * 3600 + [a[1] integerValue] * 60 &&
        seconds <= [b[0] integerValue] * 3600 + [b[1] integerValue] * 60;
}

- (NSMutableDictionary *)studytraceRecords {
    return [[[NSUserDefaults standardUserDefaults] dictionaryForKey:@"studytrace.esm.occurrences.v2"] mutableCopy] ?: [NSMutableDictionary dictionary];
}

- (void)studytraceSaveRecords:(NSDictionary *)records {
    [[NSUserDefaults standardUserDefaults] setObject:records forKey:@"studytrace.esm.occurrences.v2"];
}

- (void)studytraceSetOptions:(NSDictionary *)config scheduleId:(NSString *)scheduleId {
    NSMutableDictionary *options = [[[NSUserDefaults standardUserDefaults] dictionaryForKey:@"studytrace.esm.options.v2"] mutableCopy] ?: [NSMutableDictionary dictionary];
    options[scheduleId] = @{
        @"start": config[@"studytrace_window_start"] ?: @"",
        @"end": config[@"studytrace_window_end"] ?: @""
    };
    [[NSUserDefaults standardUserDefaults] setObject:options forKey:@"studytrace.esm.options.v2"];
}

- (BOOL)studytraceRecordNotification:(UNNotification *)notification {
    if (![NSThread isMainThread]) {
        __block BOOL allowed = NO;
        dispatch_sync(dispatch_get_main_queue(), ^{ allowed = [self studytraceRecordNotification:notification]; });
        return allowed;
    }
    NSString *identifier = notification.request.identifier;
    if (![identifier hasPrefix:@"studytrace.esm.v2|"]) return YES;
    return [self studytraceRecordDeliveryForIdentifier:identifier atDate:notification.date];
}

- (BOOL)studytraceRecordDeliveryForIdentifier:(NSString *)identifier atDate:(NSDate *)delivery {
    NSMutableDictionary *records = [self studytraceRecords];
    NSMutableDictionary *record = [records[identifier] mutableCopy];
    // A cancelled/withdrawn/config-removed occurrence cannot be resurrected by a stale tap.
    if (record == nil) return NO;
    if ([record[@"status"] isEqual:@"missed"]) return NO;
    if ([record[@"delivered_at"] doubleValue] == 0) {
        // The caller supplies UNNotification.date, never Date() at tap/foreground time.
        BOOL allowed = [ESMScheduleManager studytraceIsWithinWindow:delivery start:record[@"window_start"] end:record[@"window_end"]];
        record[@"delivered_at"] = @(delivery.timeIntervalSince1970);
        record[@"expires_at"] = @([ESMScheduleManager studytraceDeadlineForDelivery:delivery expirationMinutes:[record[@"expiration"] integerValue]].timeIntervalSince1970);
        record[@"status"] = allowed ? @"delivered" : @"missed";
        records[identifier] = record;
        [self studytraceSaveRecords:records];
        [[NSNotificationCenter defaultCenter] postNotificationName:@"StudyTraceSurveyTimingUpdated" object:nil];
        if (!allowed) {
            [[UNUserNotificationCenter currentNotificationCenter] removeDeliveredNotificationsWithIdentifiers:@[identifier]];
            return NO;
        }
    }
    return ![record[@"status"] isEqual:@"missed"];
}

- (BOOL)studytraceOccurrenceIsOpen:(NSString *)identifier atDate:(NSDate *)date {
    NSDictionary *record = [self studytraceRecords][identifier];
    return [record[@"status"] isEqual:@"delivered"] &&
        date.timeIntervalSince1970 >= [record[@"delivered_at"] doubleValue] &&
        date.timeIntervalSince1970 < [record[@"expires_at"] doubleValue];
}

- (NSDictionary *)studytraceOccurrenceForSchedule:(EntityESMSchedule *)schedule atDate:(NSDate *)date {
    NSDictionary *records = [self studytraceRecords];
    NSDictionary *newest = nil;
    for (NSString *identifier in records) {
        NSDictionary *record = records[identifier];
        if ([record[@"schedule_id"] isEqual:schedule.schedule_id] &&
            [self studytraceOccurrenceIsOpen:identifier atDate:date] &&
            (newest == nil || [record[@"delivered_at"] doubleValue] > [newest[@"delivered_at"] doubleValue])) {
            newest = record;
        }
    }
    return newest;
}

- (void)studytraceCompleteOccurrence:(NSString *)identifier {
    if (identifier.length == 0) return;
    NSMutableDictionary *records = [self studytraceRecords];
    NSMutableDictionary *record = [records[identifier] mutableCopy];
    if (record == nil || ![self studytraceOccurrenceIsOpen:identifier atDate:[NSDate date]]) return;
    record[@"status"] = @"answered";
    records[identifier] = record;
    [self studytraceSaveRecords:records];
    [[UNUserNotificationCenter currentNotificationCenter] removeDeliveredNotificationsWithIdentifiers:@[identifier]];
}

- (void)studytraceClearTiming {
    [[NSUserDefaults standardUserDefaults] removeObjectForKey:@"studytrace.esm.occurrences.v2"];
    [[NSUserDefaults standardUserDefaults] removeObjectForKey:@"studytrace.esm.options.v2"];
}

- (void)studytraceRefreshNotifications {
    // UN callbacks arrive on a background queue; Core Data and state changes stay on main.
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self studytraceRefreshNotifications]; });
        return;
    }
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    [center getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *requests) {
        dispatch_async(dispatch_get_main_queue(), ^{
            NSDate *now = [NSDate date];
            NSManagedObjectContext *context = [CoreDataHandler sharedHandler].managedObjectContext;
            if (context == nil) return;
            NSFetchRequest *fetch = [NSFetchRequest fetchRequestWithEntityName:@"EntityESMSchedule"];
            fetch.predicate = [NSPredicate predicateWithFormat:@"fire_hour >= 0 AND (temporary == NO OR temporary == nil)"];
            NSArray<EntityESMSchedule *> *schedules = [context executeFetchRequest:fetch error:nil] ?: @[];
            NSMutableSet *activeIds = [NSMutableSet set];
            for (EntityESMSchedule *schedule in schedules) if (schedule.schedule_id) [activeIds addObject:schedule.schedule_id];

            NSMutableArray *remove = [NSMutableArray array];
            NSUInteger otherCount = 0;
            for (UNNotificationRequest *request in requests) {
                if ([request.identifier hasPrefix:@"studytrace.esm.v2|"] ||
                    ([request.identifier hasPrefix:KEY_AWARE_NOTIFICATION_DEFAULT_REQUEST_IDENTIFIER] &&
                     [activeIds containsObject:request.content.userInfo[@"schedule_id"] ?: @""])) {
                    [remove addObject:request.identifier];
                } else { otherCount++; }
            }
            [center removePendingNotificationRequestsWithIdentifiers:remove];

            NSMutableDictionary *records = [self studytraceRecords];
            NSMutableArray *expired = [NSMutableArray array];
            // Retain delivered deadlines across schedule refreshes and midnight.
            for (NSString *identifier in [records.allKeys copy]) {
                NSMutableDictionary *record = [records[identifier] mutableCopy];
                if (![activeIds containsObject:record[@"schedule_id"]] || [record[@"planned_at"] doubleValue] < now.timeIntervalSince1970 - 7 * 86400) {
                    [records removeObjectForKey:identifier];
                    [expired addObject:identifier];
                } else if ([record[@"status"] isEqual:@"delivered"] && [record[@"expires_at"] doubleValue] <= now.timeIntervalSince1970) {
                    record[@"status"] = @"expired";
                    records[identifier] = record;
                    [expired addObject:identifier];
                }
            }
            [center removeDeliveredNotificationsWithIdentifiers:expired];

            NSCalendar *calendar = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
            calendar.timeZone = [NSTimeZone localTimeZone];
            NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
            formatter.calendar = calendar;
            formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
            formatter.timeZone = calendar.timeZone;
            formatter.dateFormat = @"yyyy-MM-dd";
            NSString *device = [[NSUserDefaults standardUserDefaults] stringForKey:@"studytrace.esm.random-seed"];
            if (device.length == 0) {
                device = [[NSUUID UUID] UUIDString];
                [[NSUserDefaults standardUserDefaults] setObject:device forKey:@"studytrace.esm.random-seed"];
            }
            NSDictionary *options = [[NSUserDefaults standardUserDefaults] dictionaryForKey:@"studytrace.esm.options.v2"] ?: @{};
            NSMutableArray<UNNotificationRequest *> *candidates = [NSMutableArray array];
            NSDate *today = [calendar startOfDayForDate:now];
            for (NSInteger day = 0; day < 21; day++) {
                NSDate *date = [calendar dateByAddingUnit:NSCalendarUnitDay value:day toDate:today options:0];
                for (EntityESMSchedule *schedule in schedules) {
                    if (schedule.start_date && [date compare:[calendar startOfDayForDate:schedule.start_date]] == NSOrderedAscending) continue;
                    if (schedule.end_date && [date compare:[calendar startOfDayForDate:schedule.end_date]] == NSOrderedDescending) continue;
                    NSInteger minute = [schedule.timer isKindOfClass:[NSDateComponents class]] ? ((NSDateComponents *)schedule.timer).minute : 0;
                    NSString *identifier = [NSString stringWithFormat:@"studytrace.esm.v2|%@|%@", schedule.schedule_id, [formatter stringFromDate:date]];
                    NSDictionary *existing = records[identifier];
                    if (existing && ![existing[@"status"] isEqual:@"scheduled"]) continue;
                    NSDate *anchor = [calendar dateBySettingHour:schedule.fire_hour.integerValue minute:minute second:0 ofDate:date options:0];
                    NSString *seed = [NSString stringWithFormat:@"%@|%@", device, identifier];
                    NSInteger offset = [ESMScheduleManager studytraceOffsetForSeed:seed range:MIN(180, MAX(0, schedule.randomize_schedule.integerValue))];
                    NSDate *fire = [anchor dateByAddingTimeInterval:offset * 60];
                    // Do not replace a past draw with an immediate notification on refresh.
                    if ([fire compare:now] != NSOrderedDescending) continue;
                    NSDictionary *window = options[schedule.schedule_id] ?: @{};
                    if (![ESMScheduleManager studytraceIsWithinWindow:fire start:window[@"start"] end:window[@"end"]]) continue;
                    NSMutableDictionary *record = [@{
                        @"id": identifier, @"schedule_id": schedule.schedule_id,
                        @"planned_at": @(fire.timeIntervalSince1970), @"expiration": schedule.expiration_threshold ?: @0,
                        @"window_start": window[@"start"] ?: @"", @"window_end": window[@"end"] ?: @"",
                        @"status": @"scheduled"
                    } mutableCopy];
                    records[identifier] = record;
                    UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
                    content.title = schedule.notification_title ?: @"StudyTrace survey";
                    content.body = schedule.notification_body ?: @"Please complete your scheduled study survey.";
                    content.sound = [UNNotificationSound defaultSound];
                    content.categoryIdentifier = self->categoryNormalESM;
                    content.threadIdentifier = @"studytrace.esm";
                    content.badge = @1;
                    content.userInfo = @{ @"schedule_id": schedule.schedule_id, @"notification_id": identifier,
                                          @"planned_at": @(fire.timeIntervalSince1970 * 1000),
                                          @"window_start": window[@"start"] ?: @"", @"window_end": window[@"end"] ?: @"",
                                          @"expiration_threshold": schedule.expiration_threshold ?: @0 };
                    if (@available(iOS 15.0, *)) content.interruptionLevel = UNNotificationInterruptionLevelTimeSensitive;
                    NSDateComponents *components = [calendar components:NSCalendarUnitYear|NSCalendarUnitMonth|NSCalendarUnitDay|NSCalendarUnitHour|NSCalendarUnitMinute|NSCalendarUnitSecond fromDate:fire];
                    components.timeZone = calendar.timeZone;
                    UNCalendarNotificationTrigger *trigger = [UNCalendarNotificationTrigger triggerWithDateMatchingComponents:components repeats:NO];
                    [candidates addObject:[UNNotificationRequest requestWithIdentifier:identifier content:content trigger:trigger]];
                }
            }
            [candidates sortUsingComparator:^NSComparisonResult(UNNotificationRequest *a, UNNotificationRequest *b) {
                double first = [a.content.userInfo[@"planned_at"] doubleValue];
                double second = [b.content.userInfo[@"planned_at"] doubleValue];
                return first < second ? NSOrderedAscending : (first > second ? NSOrderedDescending : NSOrderedSame);
            }];
            [self studytraceSaveRecords:records];
            // iOS permits 64 pending local notifications. Reserve capacity for other features.
            NSUInteger capacity = otherCount < 56 ? 56 - otherCount : 0;
            for (NSUInteger i = 0; i < MIN(capacity, candidates.count); i++) {
                [center addNotificationRequest:candidates[i] withCompletionHandler:^(NSError *error) {
                    if (error) NSLog(@"[StudyTrace ESM] Could not schedule notification: %@", error);
                }];
            }
        });
    }];
}
