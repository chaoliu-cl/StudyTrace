//
//  ESMScheduleManager.h
//  AWAREFramework
//
//  Created by Yuuki Nishiyama on 2018/03/27.
//

#import <Foundation/Foundation.h>
#import "ESMSchedule.h"
#import "ESMItem.h"

@class UNNotification;

@interface ESMScheduleManager : NSObject

+ (ESMScheduleManager * _Nonnull) sharedESMScheduleManager;

@property BOOL debug;

typedef void (^NotificationRemoveCompleteHandler)(void);

- (BOOL) setScheduleByConfig:(NSArray <NSDictionary * > * _Nonnull) config;
- (BOOL) addSchedule:(ESMSchedule * _Nonnull)schedule;
- (BOOL) addSchedule:(ESMSchedule * _Nonnull)schedule withNotification:(BOOL)notification;
- (BOOL) deleteScheduleWithId:(NSString * _Nonnull)scheduleId;
- (BOOL) deleteAllSchedules;
- (BOOL) deleteAllSchedulesWithNotification:(BOOL)notification;
- (NSArray<EntityESMSchedule *> * _Nullable) getESMSchedules;
- (NSArray * _Nonnull) getValidSchedules;
- (NSArray * _Nonnull) getValidSchedulesWithDatetime:(NSDate * _Nonnull)datetime;

- (BOOL) removeAllSchedulesFromDB;
- (BOOL) removeAllESMHitoryFromDB;

// - (void) removeAllNotifications;
- (void) removeESMNotificationsWithHandler:(NotificationRemoveCompleteHandler _Nullable)handler;
- (void) refreshESMNotifications;

- (BOOL) saveESMAnswerWithTimestamp:(NSNumber * _Nonnull) timestamp
                           deviceId:(NSString * _Nonnull) deviceId
                            esmJson:(NSString * _Nonnull) esmJson
                         esmTrigger:(NSString * _Nonnull) esmTrigger
             esmExpirationThreshold:(NSNumber * _Nonnull) esmExpirationThreshold
             esmUserAnswerTimestamp:(NSNumber * _Nonnull) esmUserAnswerTimestamp
                      esmUserAnswer:(NSString * _Nonnull) esmUserAnswer
                          esmStatus:(NSNumber * _Nonnull) esmStatus;

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

@end
