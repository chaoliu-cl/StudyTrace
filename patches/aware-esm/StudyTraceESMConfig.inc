- (void)setESMSchedulesWithData:(NSData *)data response:(NSURLResponse *)response error:(NSError *)error {
    // Refresh without an empty-cache gap between removal and replacement.
    // Failed downloads leave the last usable configuration intact.
    NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? [(NSHTTPURLResponse *)response statusCode] : 200;
    NSError *parseError = nil;
    id decoded = data.length > 0 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&parseError] : nil;
    NSArray *config = [decoded isKindOfClass:[NSArray class]] ? decoded : nil;
    BOOL valid = config != nil;
    if (valid) for (id schedule in config) {
        if (![schedule isKindOfClass:[NSDictionary class]] ||
            ![schedule[@"schedule_id"] isKindOfClass:[NSString class]] ||
            ![schedule[@"esms"] isKindOfClass:[NSArray class]]) { valid = NO; break; }
    }
    if (error != nil || status < 200 || status >= 300 || parseError != nil || !valid) {
        if (self->errorHandler) self->errorHandler(error ?: parseError ?: [NSError errorWithDomain:@"StudyTraceESMConfig" code:status userInfo:nil]);
        return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        ESMScheduleManager *manager = [ESMScheduleManager sharedESMScheduleManager];
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        NSData *previousData = [defaults objectForKey:@"previous.ios.esm.plugin.configuration.file"];
        NSArray *previous = [previousData isKindOfClass:[NSData class]] ? [NSJSONSerialization JSONObjectWithData:previousData options:0 error:nil] : nil;
        BOOL unchanged = [previous isKindOfClass:[NSArray class]] && [config isEqualToArray:previous] &&
            ([config count] == 0 || [manager getESMSchedules].count > 0);
        if (unchanged) {
            [manager refreshESMNotifications];
        } else {
            // No notification-center callback between deletion and replacement:
            // taps/foreground events cannot observe a transient empty database.
            BOOL ready = [manager removeAllSchedulesFromDB] && [manager setScheduleByConfig:config];
            if (!ready) {
                if ([previous isKindOfClass:[NSArray class]]) {
                    [manager removeAllSchedulesFromDB];
                    [manager setScheduleByConfig:previous];
                }
                if (self->errorHandler) self->errorHandler([NSError errorWithDomain:@"StudyTraceESMConfig" code:1 userInfo:nil]);
                return;
            }
            [defaults setObject:[NSJSONSerialization dataWithJSONObject:config options:0 error:nil] forKey:@"previous.ios.esm.plugin.configuration.file"];
        }
        [[NSNotificationCenter defaultCenter] postNotificationName:@"StudyTraceESMConfigurationUpdated" object:nil];
        if (self->completionHandler) self->completionHandler();
    });
}
