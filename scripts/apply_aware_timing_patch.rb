# Reapply the maintained ESM fixes after `pod install`. Fails if upstream method
# signatures change instead of silently shipping an unpatched scheduler.
require 'pathname'

root = Pathname.new(__dir__).parent
esm = ARGV[0] ? Pathname.new(ARGV[0]) : root.join('Pods/AWAREFramework/AWAREFramework/Classes/ESM')

def replace_method(source, signature, replacement)
  start = source.index(signature) or raise "Missing AWARE method: #{signature}"
  opening = source.index('{', start) or raise "Missing method body: #{signature}"
  # Method endings in these Objective-C files occupy a line of their own.
  ending = source.index(/^\}/, opening) or raise "Missing method end: #{signature}"
  source[0...start] + replacement.rstrip + "\n\n" + source[(ending + 1)..].sub(/\A\n+/, '')
end

def insert_once(source, marker, addition)
  return source if source.include?(addition + marker)
  raise "Missing patch anchor: #{marker}" unless source.include?(marker)
  source.sub(marker, addition + marker)
end

def write_patched(path, text)
  return if path.read == text
  # CocoaPods can install read-only source files. The owner can unlock them.
  File.chmod(File.stat(path).mode | 0o200, path)
  path.write(text)
end

header = esm.join('ESMScheduleManager.h')
declarations = <<~'OBJC'
  // StudyTrace delivery-based timing (implemented in the maintained .inc file).
  + (NSDate * _Nonnull)studytraceDeadlineForDelivery:(NSDate * _Nonnull)delivery expirationMinutes:(NSInteger)minutes NS_SWIFT_NAME(studytraceDeadline(delivery:expirationMinutes:));
  + (BOOL)studytraceIsOpenWithDelivery:(NSDate * _Nonnull)delivery expirationMinutes:(NSInteger)minutes now:(NSDate * _Nonnull)now NS_SWIFT_NAME(studytraceIsOpen(delivery:expirationMinutes:now:));
  + (NSInteger)studytraceOffsetForSeed:(NSString * _Nonnull)seed range:(NSInteger)range NS_SWIFT_NAME(studytraceOffset(seed:range:));
  + (BOOL)studytraceIsWithinWindow:(NSDate * _Nonnull)date start:(NSString * _Nullable)start end:(NSString * _Nullable)end NS_SWIFT_NAME(studytraceIsWithinWindow(_:start:end:));
  - (BOOL)studytraceRecordNotification:(UNNotification * _Nonnull)notification NS_SWIFT_NAME(studytraceRecordNotification(_:));
  - (BOOL)studytraceRecordDeliveryForIdentifier:(NSString * _Nonnull)identifier atDate:(NSDate * _Nonnull)delivery NS_SWIFT_NAME(studytraceRecordDelivery(identifier:at:));
  - (BOOL)studytraceOccurrenceIsOpen:(NSString * _Nonnull)identifier atDate:(NSDate * _Nonnull)date NS_SWIFT_NAME(studytraceOccurrenceIsOpen(_:at:));
  - (NSDictionary * _Nullable)studytraceOccurrenceForSchedule:(EntityESMSchedule * _Nonnull)schedule atDate:(NSDate * _Nonnull)date NS_SWIFT_NAME(studytraceOccurrence(for:at:));
  - (void)studytraceCompleteOccurrence:(NSString * _Nonnull)identifier NS_SWIFT_NAME(studytraceCompleteOccurrence(_:));
  - (void)studytraceClearTiming;

OBJC
text = header.read.gsub("\r\n", "\n")
text = text.sub(%r{// StudyTrace delivery-based timing.*?(?=@end)}m, '')
text = insert_once(text, '@interface ESMScheduleManager', "@class UNNotification;\n\n")
text = insert_once(text, '@end', declarations)
write_patched(header, text)

manager = esm.join('ESMScheduleManager.m')
text = manager.read.gsub("\r\n", "\n")
unless text.include?('- (NSArray<NSDateComponents *> *)normalizedScheduleTimesFromTimes:')
  text = insert_once(text, '- (BOOL) setScheduleByConfig:', root.join('patches/aware-esm/ScheduleTimes.inc').read)
  text = text.sub('        NSArray * hours = [schedule objectForKey:@"hours"];', <<~'OBJC'.rstrip)
          NSArray * hours = [schedule objectForKey:@"hours"];
          NSArray * times = [schedule objectForKey:@"times"];
          NSArray<NSDateComponents *> *scheduleTimes = [self normalizedScheduleTimesFromTimes:times hours:hours];
OBJC
  text = text.sub('        for (NSNumber * hour in hours) {', <<~'OBJC'.rstrip)
          for (NSDateComponents *scheduleTime in scheduleTimes) {
              NSNumber *hour = @(scheduleTime.hour);
              NSNumber *minute = @(scheduleTime.minute);
OBJC
  text = text.sub('            entityESMSchedule.fire_hour  = hour;', "            entityESMSchedule.fire_hour = hour;\n            entityESMSchedule.timer = scheduleTime;")
  text = text.sub('            entityESMSchedule.schedule_id = scheduleId;', '            entityESMSchedule.schedule_id = [NSString stringWithFormat:@"%@_%02d%02d", scheduleId, hour.intValue, minute.intValue];')
end
text = insert_once(text, '#import "AWAREKeys.h"', "#include <stdint.h>\n")
text = insert_once(text, '+ (ESMScheduleManager * _Nonnull)sharedESMScheduleManager', "#include \"../../../../../patches/aware-esm/StudyTraceESMTiming.inc\"\n\n")
text = insert_once(text, '            entityESMSchedule.contexts    = eventContext;', "            [self studytraceSetOptions:schedule scheduleId:entityESMSchedule.schedule_id];\n")
text = replace_method(text, '- (BOOL) isValidHourBasedESMSchedule:', <<~'OBJC')
  - (BOOL) isValidHourBasedESMSchedule:(EntityESMSchedule *)schedule history:(NSArray *)history targetDatetime:(NSDate *)datetime {
      return [self studytraceOccurrenceForSchedule:schedule atDate:datetime] != nil;
  }
OBJC
text = replace_method(text, '- (void) setHourBasedNotification:', <<~'OBJC')
  - (void) setHourBasedNotification:(EntityESMSchedule *)schedule datetime:(NSDate *)datetime {
      // Schedule all dated occurrences after the managed-object context is saved.
  }
OBJC
text = replace_method(text, '- (void) refreshESMNotifications', <<~'OBJC')
  - (void) refreshESMNotifications {
      [self studytraceRefreshNotifications];
  }
OBJC
# Make the end date inclusive; the response deadline can extend into the following day.
text = insert_once(text, '        if(expiration == nil) expiration = @0;', <<~'OBJC')
          if (endDateStr.length > 0 && [formatter dateFromString:endDateStr] != nil) {
              endDate = [[[NSCalendar currentCalendar] dateByAddingUnit:NSCalendarUnitDay value:1 toDate:endDate options:0] dateByAddingTimeInterval:-1];
          }

OBJC
# Query active response occurrences even after the configured last day; generation
# still enforces the configured date range. This avoids truncating a late prompt.
text = text.sub('    [req setPredicate:[NSPredicate predicateWithFormat:@"(start_date <= %@) AND (end_date >= %@)", datetime, datetime]];', '    [req setPredicate:[NSPredicate predicateWithFormat:@"(fire_hour >= 0) OR ((start_date <= %@) AND (end_date >= %@))", datetime, datetime]];')
text = insert_once(text, '    return saved;', "    if (saved && notification) [self refreshESMNotifications];\n")
text = text.gsub('if ([identifer hasPrefix:KEY_AWARE_NOTIFICATION_DEFAULT_REQUEST_IDENTIFIER]) {', 'if ([identifer hasPrefix:KEY_AWARE_NOTIFICATION_DEFAULT_REQUEST_IDENTIFIER] || [identifer hasPrefix:@"studytrace.esm.v2|"]) {')
write_patched(manager, text)

controller = esm.join('ESMScrollViewController.m')
text = controller.read.gsub("\r\n", "\n")
text = insert_once(text, '    NSNumber * sessionTimestamp;', "    NSString *studytraceOccurrenceId;\n    NSString *studytraceScheduleId;\n")
text = insert_once(text, '- (void) pushedSubmitButton:(id) senser {', <<~'OBJC')
  - (BOOL)studytraceValidateSession {
      if (studytraceOccurrenceId == nil) return YES; // Context/demo surveys have no delivery window.
      ESMScheduleManager *manager = [ESMScheduleManager sharedESMScheduleManager];
      if ([manager studytraceOccurrenceIsOpen:studytraceOccurrenceId atDate:[NSDate date]]) return YES;
      UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Survey closed" message:@"The response window for this survey has ended." preferredStyle:UIAlertControllerStyleAlert];
      [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) {
          [self.navigationController popToRootViewControllerAnimated:YES];
          [self dismissViewControllerAnimated:YES completion:nil];
      }]];
      [self presentViewController:alert animated:YES completion:nil];
      return NO;
  }

OBJC
text = insert_once(text, '    AudioServicesPlaySystemSound(1105);', "    if (![self studytraceValidateSession]) return;\n")
text = insert_once(text, '    AudioServicesPlaySystemSound(1104);', "    if (![self studytraceValidateSession]) return;\n")
text = text.sub("    esmSchedules = [[NSArray alloc] init];\n    if (![self studytraceValidateSession]) return;", "    esmSchedules = [[NSArray alloc] init];")
text = text.sub("    [super viewDidAppear:animated];\n    esmCells", "    [super viewDidAppear:animated];\n    if (![self studytraceValidateSession]) return;\n    esmCells")
text = insert_once(text, '            EntityESMSchedule * esmSchedule = esmSchedules[0];', <<~'OBJC')
              if (studytraceOccurrenceId != nil) {
                  NSPredicate *sameSchedule = [NSPredicate predicateWithFormat:@"schedule_id == %@", studytraceScheduleId];
                  esmSchedules = [esmSchedules filteredArrayUsingPredicate:sameSchedule];
                  if (esmSchedules.count == 0) return;
              }
OBJC
text = insert_once(text, '            if (study.isDebug) NSLog(@"[interface: %@]", esmSchedule.interface);', <<~'OBJC')
              if (studytraceOccurrenceId == nil && esmSchedule.fire_hour.integerValue >= 0) {
                  NSDictionary *occurrence = [esmManager studytraceOccurrenceForSchedule:esmSchedule atDate:[NSDate date]];
                  studytraceOccurrenceId = occurrence[@"id"];
                  studytraceScheduleId = esmSchedule.schedule_id;
                  sessionTimestamp = @([occurrence[@"delivered_at"] doubleValue] * 1000);
              }
OBJC
text = insert_once(text, '            answer.device_id   = deviceId;', "            if (studytraceOccurrenceId != nil) answer.timestamp = sessionTimestamp;\n")
text = insert_once(text, '            answer.double_esm_user_answer_timestamp = unixtime;', <<~'OBJC')
              if (studytraceOccurrenceId != nil) {
                  NSDictionary *timing = [[ESMScheduleManager sharedESMScheduleManager] studytraceOccurrenceForSchedule:esmSchedules[0] atDate:[NSDate date]];
                  answer.esm_expiration_threshold = @([timing[@"expires_at"] doubleValue] - [timing[@"delivered_at"] doubleValue]);
              }
OBJC
text = text.sub("    if (_isSaveAnswer) {\n        NSError * error", "    if (_isSaveAnswer) {\n        if (![self studytraceValidateSession]) return;\n        NSError * error")
text = insert_once(text, '    EntityESMAnswerHistory * entityESMHistory', "    [[ESMScheduleManager sharedESMScheduleManager] studytraceCompleteOccurrence:studytraceOccurrenceId];\n    studytraceOccurrenceId = nil;\n")
write_patched(controller, text)
puts 'StudyTrace AWARE timing patch applied.'
