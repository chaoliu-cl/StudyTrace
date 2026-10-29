#import "ESMPictureView.h"
#import <PhotosUI/PhotosUI.h>
#import <ImageIO/ImageIO.h>
#import <objc/runtime.h>

@interface ESMPictureView () <PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate>
@property NSMutableArray<NSString *> *studytraceImages;
@property UIStackView *studytraceThumbnails;
@property UILabel *studytraceCount;
@property BOOL studytraceLoading;
@end

@implementation ESMPictureView

- (instancetype)initWithFrame:(CGRect)frame esm:(EntityESM *)esm viewController:(UIViewController *)viewController {
    self = [super initWithFrame:frame esm:esm viewController:viewController];
    if (!self) return nil;
    self.studytraceImages = [NSMutableArray array];
    self.mainView.frame = CGRectMake(self.mainView.frame.origin.x, self.mainView.frame.origin.y, frame.size.width, 360);
    UIStackView *stack = [[UIStackView alloc] initWithFrame:CGRectMake(20, 8, frame.size.width - 40, 340)];
    stack.axis = UILayoutConstraintAxisVertical;
    stack.spacing = 10;
    stack.autoresizingMask = UIViewAutoresizingFlexibleWidth;
    self.studytraceCount = [UILabel new];
    self.studytraceCount.numberOfLines = 0;
    self.studytraceCount.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
    self.studytraceCount.adjustsFontForContentSizeCategory = YES;
    [stack addArrangedSubview:self.studytraceCount];
    UIScrollView *scroll = [UIScrollView new];
    [scroll.heightAnchor constraintEqualToConstant:90].active = YES;
    self.studytraceThumbnails = [UIStackView new];
    self.studytraceThumbnails.spacing = 8;
    [scroll addSubview:self.studytraceThumbnails];
    [stack addArrangedSubview:scroll];
    for (NSString *title in @[@"Choose photos", @"Take a photo", @"Remove all photos"]) {
        UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
        [button setTitle:title forState:UIControlStateNormal];
        button.titleLabel.font = [UIFont preferredFontForTextStyle:UIFontTextStyleHeadline];
        [button.heightAnchor constraintGreaterThanOrEqualToConstant:44].active = YES;
        SEL action = [title isEqualToString:@"Choose photos"] ? @selector(studytraceChoose) : ([title isEqualToString:@"Take a photo"] ? @selector(studytraceCamera) : @selector(studytraceClear));
        [button addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
        [stack addArrangedSubview:button];
    }
    [self.mainView addSubview:stack];
    [self studytraceRefresh];
    [self refreshSizeOfRootView];
    return self;
}

- (void)studytraceMessage:(NSString *)message {
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Survey photos" message:message preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
    [self.viewController presentViewController:alert animated:YES completion:nil];
}

- (void)studytraceChoose {
    if (self.studytraceLoading) return;
    if (self.studytraceImages.count >= 10) { [self studytraceMessage:@"You can attach up to 10 photos per question. Remove a photo to choose another."]; return; }
    PHPickerConfiguration *config = [[PHPickerConfiguration alloc] init];
    config.filter = PHPickerFilter.imagesFilter;
    config.selectionLimit = 10 - self.studytraceImages.count;
    PHPickerViewController *picker = [[PHPickerViewController alloc] initWithConfiguration:config];
    picker.delegate = self;
    objc_setAssociatedObject(self.viewController, NSSelectorFromString(@"studytraceMediaPickerActive"), @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [self.viewController presentViewController:picker animated:YES completion:nil];
}

- (void)picker:(PHPickerViewController *)picker didFinishPicking:(NSArray<PHPickerResult *> *)results {
    self.studytraceLoading = results.count > 0;
    [self studytraceRefresh];
    [picker dismissViewControllerAnimated:YES completion:^{ [self studytraceRead:results index:0]; }];
}

- (void)studytraceRead:(NSArray<PHPickerResult *> *)results index:(NSUInteger)index {
    if (index >= results.count) { self.studytraceLoading = NO; [self studytraceRefresh]; return; }
    [results[index].itemProvider loadFileRepresentationForTypeIdentifier:@"public.image" completionHandler:^(NSURL *url, NSError *error) {
        UIImage *image = nil;
        if (url) {
            CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
            if (source) {
                NSDictionary *options = @{(id)kCGImageSourceCreateThumbnailFromImageAlways:@YES, (id)kCGImageSourceThumbnailMaxPixelSize:@2800, (id)kCGImageSourceCreateThumbnailWithTransform:@YES};
                CGImageRef thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
                if (thumbnail) { image = [UIImage imageWithCGImage:thumbnail]; CGImageRelease(thumbnail); }
                CFRelease(source);
            }
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            if (image) [self studytraceAppend:image];
            else [self studytraceMessage:@"A selected photo could not be loaded. Please choose it again."];
            [self studytraceRead:results index:index + 1];
        });
    }];
}

- (void)studytraceCamera {
    if (self.studytraceLoading) return;
    if (self.studytraceImages.count >= 10) { [self studytraceMessage:@"Up to 10 photos can be attached."]; return; }
    if (![UIImagePickerController isSourceTypeAvailable:UIImagePickerControllerSourceTypeCamera]) { [self studytraceMessage:@"This device has no available camera. Choose an existing photo instead."]; return; }
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
    if (status == AVAuthorizationStatusNotDetermined) {
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL granted) {
            dispatch_async(dispatch_get_main_queue(), ^{ [self studytraceCamera]; });
        }]; return;
    }
    if (status != AVAuthorizationStatusAuthorized) { [self studytraceMessage:@"Enable StudyTrace camera access in iPhone Settings to take photos, or choose an existing photo."]; return; }
    UIImagePickerController *picker = [UIImagePickerController new];
    picker.sourceType = UIImagePickerControllerSourceTypeCamera;
    picker.delegate = self;
    objc_setAssociatedObject(self.viewController, NSSelectorFromString(@"studytraceMediaPickerActive"), @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [self.viewController presentViewController:picker animated:YES completion:nil];
}

- (void)imagePickerController:(UIImagePickerController *)picker didFinishPickingMediaWithInfo:(NSDictionary<UIImagePickerControllerInfoKey,id> *)info {
    UIImage *image = info[UIImagePickerControllerOriginalImage];
    [picker dismissViewControllerAnimated:YES completion:^{ if (image) [self studytraceAppend:image]; }];
}

- (void)imagePickerControllerDidCancel:(UIImagePickerController *)picker { [picker dismissViewControllerAnimated:YES completion:nil]; }

- (void)studytraceAppend:(UIImage *)image {
    if (self.studytraceImages.count >= 10) return;
    CGFloat scale = MIN(1, 2800 / MAX(image.size.width, image.size.height));
    UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
    format.scale = 1;
    CGSize size = CGSizeMake(image.size.width * scale, image.size.height * scale);
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size format:format];
    // Redrawing strips original EXIF/GPS metadata and fixes camera orientation.
    UIImage *clean = [renderer imageWithActions:^(UIGraphicsImageRendererContext *ctx) { [image drawInRect:CGRectMake(0, 0, size.width, size.height)]; }];
    NSData *data = UIImageJPEGRepresentation(clean, 0.85);
    NSString *encoded = [@"data:image/jpeg;base64," stringByAppendingString:[data base64EncodedStringWithOptions:0]];
    NSUInteger total = encoded.length;
    for (NSString *previous in self.studytraceImages) total += previous.length;
    if (!data || total > 16 * 1024 * 1024) { [self studytraceMessage:@"These photos exceed 12 MiB combined. Please choose fewer or smaller photos."]; return; }
    [self.studytraceImages addObject:encoded];
    [self studytraceRefresh];
}

- (void)studytraceClear { if (!self.studytraceLoading) { [self.studytraceImages removeAllObjects]; [self studytraceRefresh]; } }

- (void)studytraceRemove:(UIButton *)button {
    if (self.studytraceLoading || button.tag >= self.studytraceImages.count) return;
    [self.studytraceImages removeObjectAtIndex:button.tag];
    [self studytraceRefresh];
}

- (void)studytraceRefresh {
    self.studytraceCount.text = self.studytraceLoading ? @"Preparing selected photos…" : [NSString stringWithFormat:@"%lu of 10 photos attached. Tap a thumbnail to remove it.", (unsigned long)self.studytraceImages.count];
    for (UIView *view in self.studytraceThumbnails.arrangedSubviews) { [self.studytraceThumbnails removeArrangedSubview:view]; [view removeFromSuperview]; }
    [self.studytraceImages enumerateObjectsUsingBlock:^(NSString *encoded, NSUInteger index, BOOL *stop) {
        NSString *base64 = [[encoded componentsSeparatedByString:@","] lastObject];
        UIImage *image = [UIImage imageWithData:[[NSData alloc] initWithBase64EncodedString:base64 options:0]];
        UIButton *thumbnail = [UIButton buttonWithType:UIButtonTypeCustom];
        [thumbnail setImage:image forState:UIControlStateNormal];
        thumbnail.imageView.contentMode = UIViewContentModeScaleAspectFit;
        thumbnail.tag = index;
        thumbnail.accessibilityLabel = [NSString stringWithFormat:@"Remove photo %lu", (unsigned long)index + 1];
        [thumbnail addTarget:self action:@selector(studytraceRemove:) forControlEvents:UIControlEventTouchUpInside];
        [thumbnail.widthAnchor constraintEqualToConstant:80].active = YES;
        [self.studytraceThumbnails addArrangedSubview:thumbnail];
    }];
    self.studytraceThumbnails.frame = CGRectMake(0, 0, self.studytraceImages.count * 88, 90);
    ((UIScrollView *)self.studytraceThumbnails.superview).contentSize = self.studytraceThumbnails.frame.size;
}

- (NSNumber *)getESMState { return (!self.studytraceLoading && (self.studytraceImages.count || [self isNA])) ? @2 : @1; }
- (NSString *)getUserAnswer {
    if ([self isNA]) return @"NA";
    if (!self.studytraceImages.count) return @"";
    if (self.studytraceImages.count == 1) return self.studytraceImages[0];
    NSData *data = [NSJSONSerialization dataWithJSONObject:self.studytraceImages options:0 error:nil];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
@end
