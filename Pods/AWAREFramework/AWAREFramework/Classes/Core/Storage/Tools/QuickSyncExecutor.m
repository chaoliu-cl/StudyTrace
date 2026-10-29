//
//  QuickSyncExecutorr.m
//  AppAuth
//
//  Created by Yuuki Nishiyama on 2019/12/21.
//

#import "QuickSyncExecutor.h"

@implementation QuickSyncExecutor{
    AWAREStudy * awareStudy;
    NSString   * sensorName;
    NSString   * baseSyncDataQueryIdentifier;
}

@synthesize debug;
@synthesize executorCallback;
@synthesize session;
@synthesize dataTask;

- (instancetype)initWithAwareStudy:(AWAREStudy *)study
                        sensorName:(NSString *)name{
    self = [super init];
    if (self != nil) {
        awareStudy = study;
        sensorName = name;
        debug      = [study isDebug];
        
        // Set session configuration
        NSURLSessionConfiguration * config = [NSURLSessionConfiguration defaultSessionConfiguration];
        // config.sharedContainerIdentifier= @"com.awareframework.sync.task.identifier";
        config.allowsCellularAccess = YES;
        
        session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:nil];
    }
    return self;
}



#include "../../../../../../../patches/aware-esm/StudyTraceFormUpload.inc"

- (void)syncWithData:(NSData *)data callback:(SyncExecutorCallback)callback{
    [self studytraceSyncData:data callback:callback];
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
   didSendBodyData:(int64_t)bytesSent totalBytesSent:(int64_t)totalBytesSent totalBytesExpectedToSend:(int64_t)totalBytesExpectedToSend{
    if (debug) {
        NSLog(@"[%@] ---> %3.2f%%", sensorName, (double)totalBytesSent/(double)totalBytesExpectedToSend*100.0f);
    }
}

@end

