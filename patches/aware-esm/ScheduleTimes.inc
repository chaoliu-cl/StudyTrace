- (NSArray<NSDateComponents *> *)normalizedScheduleTimesFromTimes:(NSArray *)times hours:(NSArray *)hours {
    NSMutableArray<NSDateComponents *> *components = [[NSMutableArray alloc] init];
    NSMutableSet<NSString *> *seen = [[NSMutableSet alloc] init];

    for (id value in times) {
        NSDateComponents *time = [self scheduleTimeFromValue:value];
        if (time != nil) {
            NSString *key = [NSString stringWithFormat:@"%02ld:%02ld", (long)time.hour, (long)time.minute];
            if (![seen containsObject:key]) {
                [components addObject:time];
                [seen addObject:key];
            }
        }
    }

    if (components.count == 0) {
        for (id hour in hours) {
            NSDateComponents *time = [self scheduleTimeFromValue:hour];
            if (time != nil) {
                NSString *key = [NSString stringWithFormat:@"%02ld:%02ld", (long)time.hour, (long)time.minute];
                if (![seen containsObject:key]) {
                    [components addObject:time];
                    [seen addObject:key];
                }
            }
        }
    }

    return components;
}

- (NSDateComponents *)scheduleTimeFromValue:(id)value {
    NSInteger hour = -1;
    NSInteger minute = 0;

    if ([value isKindOfClass:[NSNumber class]]) {
        hour = [value integerValue];
    } else if ([value isKindOfClass:[NSString class]]) {
        NSString *text = [(NSString *)value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        NSArray<NSString *> *parts = [text componentsSeparatedByString:@":"];
        if (parts.count == 1) {
            hour = [parts[0] integerValue];
        } else if (parts.count == 2) {
            hour = [parts[0] integerValue];
            minute = [parts[1] integerValue];
        }
    }

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return nil;
    }

    NSDateComponents *components = [[NSDateComponents alloc] init];
    components.hour = hour;
    components.minute = minute;
    components.second = 0;
    return components;
}

- (NSDate *)targetDateFromDate:(NSDate *)date hour:(NSInteger)hour minute:(NSInteger)minute nextDay:(BOOL)nextDay {
    NSCalendar *calendar = [NSCalendar currentCalendar];
    NSDateComponents *components = [calendar components:NSCalendarUnitYear|NSCalendarUnitMonth|NSCalendarUnitDay fromDate:date];
    components.hour = hour;
    components.minute = minute;
    components.second = 0;
    NSDate *target = [calendar dateFromComponents:components];
    if (nextDay) {
        target = [calendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:target options:0];
    }
    return target;
}

- (NSDate *)nextFutureDateFromDate:(NSDate *)date hour:(NSInteger)hour minute:(NSInteger)minute {
    NSDate *target = [self targetDateFromDate:date hour:hour minute:minute nextDay:NO];
    if (target.timeIntervalSince1970 <= date.timeIntervalSince1970) {
        target = [self targetDateFromDate:date hour:hour minute:minute nextDay:YES];
    }
    return target;
}
