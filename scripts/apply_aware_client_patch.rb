# Maintained fixes for AWARE 1.14.18; reapplied after every pod install.
require 'pathname'
root = Pathname.new(__dir__).parent
classes = root.join('Pods/AWAREFramework/AWAREFramework/Classes')
def write_patch(path, value)
  return if path.read == value
  File.chmod(File.stat(path).mode | 0o200, path)
  path.write(value)
end
photo = classes.join('ESM/ESMScrollViewCells/ESMPicture/ESMPictureView.m')
write_patch(photo, root.join('patches/aware-esm/StudyTracePhotoView.m').read)

%w[SyncExecutor QuickSyncExecutor DBTableCreator].each do |name|
  path = classes.join("Core/Storage/Tools/#{name}.m")
  source = path.read
  # A query string in the study invitation must not swallow the /sensor/action path.
  source = source.gsub('NSString* url = [awareStudy getStudyURL];', 'NSString* url = [[[awareStudy getStudyURL] componentsSeparatedByString:@"?"] firstObject];')
  source = source.gsub('NSString * baseURL  = [awareStudy getStudyURL];', 'NSString * baseURL  = [[[awareStudy getStudyURL] componentsSeparatedByString:@"?"] firstObject];')
  # Framework sync has no delegate restoration across launches. SQLite keeps the
  # unsent rows; foreground/BGTask bursts retry them on the next opportunity.
  source = source.gsub(/\[NSURLSessionConfiguration backgroundSessionConfigurationWithIdentifier:[^\]]+\]/, '[NSURLSessionConfiguration defaultSessionConfiguration]')
  source = source.gsub('    NSLog(@"[%@] %@", sensorName, baseURL);', '    // Study URLs contain credentials; never log them.')
  unless name == 'DBTableCreator'
    source = source.gsub(/\[mutablePostData appendData:data\];[^\n]*/, <<~'OBJC'.strip)
      // StudyTrace: encode literal JSON so +, &, %, and Unicode survive form transport.
          NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
          NSString *encoded = [json stringByAddingPercentEncodingWithAllowedCharacters:[NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"]];
          [mutablePostData appendData:[encoded dataUsingEncoding:NSUTF8StringEncoding]];
    OBJC
    unless source.include?('forHTTPHeaderField:@"Content-Type"')
      source = source.sub('[request setHTTPMethod:@"POST"];', '[request setHTTPMethod:@"POST"];' + "\n    [request setValue:@\"application/x-www-form-urlencoded\" forHTTPHeaderField:@\"Content-Type\"];")
    end
    unless source.include?('// StudyTrace HTTP acknowledgement') || source.include?('studytraceSyncData')
      if name == 'QuickSyncExecutor'
        marker = '        if (self->executorCallback != nil) {'
        check = <<~'OBJC'
          // StudyTrace HTTP acknowledgement: a 4xx/5xx response is not a successful sync.
              NSInteger status = [(NSHTTPURLResponse *)response statusCode];
              if (error == nil && (status < 200 || status >= 300)) error = [NSError errorWithDomain:@"StudyTraceHTTP" code:status userInfo:nil];
        OBJC
      else
        marker = '    if (debug) {'
        offset = source.index('didCompleteWithError:(nullable NSError *)error {') or raise 'Missing SyncExecutor completion'
        before = source[0...offset]
        source = source[offset..]
        check = <<~'OBJC'
          // StudyTrace HTTP acknowledgement: keep SQLite rows pending after a rejected upload.
              NSInteger status = [(NSHTTPURLResponse *)task.response statusCode];
              if (error == nil && (status < 200 || status >= 300)) error = [NSError errorWithDomain:@"StudyTraceHTTP" code:status userInfo:nil];
        OBJC
      end
      raise "Missing #{name} completion anchor" unless source.include?(marker)
      source = source.sub(marker, check + marker)
      source = before + source if before
    end
  end
  write_patch(path, source)
end
puts 'StudyTrace AWARE photo and sync patches applied.'

# Photo answers can exceed a row-count-only batch limit. Both iOS survey
# sensor wrappers use the bounded uploader, with acknowledgement after all parts.
quick = classes.join('Core/Storage/Tools/QuickSyncExecutor.m')
source = quick.read
signature = '- (void)syncWithData:(NSData *)data callback:(SyncExecutorCallback)callback'
start = source.index(signature) or raise 'Missing QuickSyncExecutor method'
opening = source.index('{', start)
ending = source.index(/^\}/, opening) or raise 'Missing QuickSyncExecutor method end'
source = source[0...start] + signature + "{\n    [self studytraceSyncData:data callback:callback];\n}\n" + source[(ending + 1)..].sub(/\A\n+/, "\n")
source = source.gsub('#include "../../../../../../patches/aware-esm/StudyTraceFormUpload.inc"', '')
include_line = '#include "../../../../../../../patches/aware-esm/StudyTraceFormUpload.inc"'
source = source.sub(signature, include_line + "\n\n" + signature) unless source.include?(include_line)
write_patch(quick, source)

# The upstream controller rebuilds every question on viewDidAppear. Returning
# from a photo picker must preserve the current views and their draft answers.
controller = classes.join('ESM/ESMScrollViewController.m')
source = controller.read
source = source.sub('#import "ESMPictureView.h"', "#import \"ESMPictureView.h\"\n#import <objc/runtime.h>") unless source.include?('#import <objc/runtime.h>')
marker = '    [super viewDidAppear:animated];'
unless source.include?('studytraceMediaPickerActive')
  source = source.sub(marker, marker + <<~'OBJC')

      if ([objc_getAssociatedObject(self, NSSelectorFromString(@"studytraceMediaPickerActive")) boolValue]) {
          objc_setAssociatedObject(self, NSSelectorFromString(@"studytraceMediaPickerActive"), nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
          [self studytraceValidateSession];
          return;
      }
OBJC
end
write_patch(controller, source)

# A zero cursor is a valid request to replay local data. The upstream init
# replaced it with 'now' on relaunch, discarding recovery after an offline run.
storage = classes.join('Core/Storage/SQLite/SQLiteStorage.m')
source = storage.read
source = source.sub(/        if\(\[previousUploadingProcessFinishUnixTime isEqualToNumber:@0\]\)\{\n            NSDate \* now = \[NSDate new\];\n            \[self setTimeMark:now\];\n        \}/, '        // StudyTrace: preserve a zero replay cursor across relaunches.')
unless source.include?('NSString *studytraceTimeKey =')
  source = source.sub('            NSSortDescriptor *sortDescriptor = [[NSSortDescriptor alloc] initWithKey:@"timestamp" ascending:YES];', '            NSString *studytraceTimeKey = [self->entityName isEqualToString:@"EntityESMAnswer"] ? @"double_esm_user_answer_timestamp" : @"timestamp";' + "\n            NSSortDescriptor *sortDescriptor = [[NSSortDescriptor alloc] initWithKey:studytraceTimeKey ascending:YES];")
end
marker = '            NSArray *results = [private executeFetchRequest:fetchRequest error:nil] ;'
unless source.include?('// StudyTrace: include the complete final timestamp group')
  source = source.sub(marker, marker + <<~'OBJC')

              // StudyTrace: include the complete final timestamp group so a
              // row-count boundary cannot permanently skip sibling answers.
              if (results.count > 0 && results.count == fetchRequest.fetchLimit) {
                  NSNumber *lastTime = results.lastObject[studytraceTimeKey];
                  NSFetchRequest *ties = [fetchRequest copy];
                  ties.fetchLimit = 0;
                  ties.predicate = [NSPredicate predicateWithFormat:@"%K == %@", studytraceTimeKey, lastTime];
                  NSArray *tail = [private executeFetchRequest:ties error:nil];
                  if (tail.count) {
                      NSMutableArray *complete = [NSMutableArray array];
                      for (NSDictionary *row in results) if (![row[studytraceTimeKey] isEqual:lastTime]) [complete addObject:row];
                      [complete addObjectsFromArray:tail];
                      results = complete;
                  }
              }
OBJC
end
write_patch(storage, source)

# The schedule plugin and ordinary ESM wrapper share EntityESMAnswer. Prefer
# one uploader so each new questionnaire is not sent to two separate tables.
controller = classes.join('ESM/ESMScrollViewController.m')
source = controller.read
unless source.include?('// StudyTrace: one canonical survey uploader')
  source = source.sub('    if ([manager getSensor:SENSOR_ESMS] == nil ) {', <<~'OBJC'.rstrip)
      // StudyTrace: one canonical survey uploader for the shared answer store.
      if ([manager getSensor:SENSOR_PLUGIN_IOS_ESM] != nil) {
          esmSensor = (ESM *)[manager getSensor:SENSOR_PLUGIN_IOS_ESM];
      } else if ([manager getSensor:SENSOR_ESMS] == nil ) {
  OBJC
end
write_patch(controller, source)
