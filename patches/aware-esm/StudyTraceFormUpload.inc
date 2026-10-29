// Keep a SQLite batch pending until EVERY bounded HTTP request is acknowledged.
// If request 2 fails, request 1 can safely repeat because ingestion deduplicates.
- (void)studytraceSyncData:(NSData *)data callback:(SyncExecutorCallback)callback {
    NSError *error = nil;
    id decoded = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (![decoded isKindOfClass:NSArray.class]) {
        if (callback) callback(@{@"result":@NO, @"name":sensorName, @"error":@"Invalid sensor JSON"});
        return;
    }
    NSMutableArray<NSData *> *batches = [NSMutableArray array];
    NSMutableData *batch = [NSMutableData dataWithData:[@"%5B" dataUsingEncoding:NSUTF8StringEncoding]];
    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"];
    for (id row in decoded) {
        NSData *json = [NSJSONSerialization dataWithJSONObject:row options:0 error:&error];
        NSString *text = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        NSData *encoded = [[text stringByAddingPercentEncodingWithAllowedCharacters:allowed] dataUsingEncoding:NSUTF8StringEncoding];
        if (!encoded || encoded.length > 20 * 1024 * 1024) {
            if (callback) callback(@{@"result":@NO, @"name":sensorName, @"error":@"Sensor row exceeds the upload limit"});
            return;
        }
        if (batch.length > 3 && batch.length + encoded.length > 20 * 1024 * 1024) {
            [batch appendData:[@"%5D" dataUsingEncoding:NSUTF8StringEncoding]];
            [batches addObject:batch];
            batch = [NSMutableData dataWithData:[@"%5B" dataUsingEncoding:NSUTF8StringEncoding]];
        }
        if (batch.length > 3) [batch appendData:[@"%2C" dataUsingEncoding:NSUTF8StringEncoding]];
        [batch appendData:encoded];
    }
    [batch appendData:[@"%5D" dataUsingEncoding:NSUTF8StringEncoding]];
    [batches addObject:batch];
    [self studytraceUploadBatches:batches index:0 callback:callback];
}

- (void)studytraceUploadBatches:(NSArray<NSData *> *)batches index:(NSUInteger)index callback:(SyncExecutorCallback)callback {
    NSString *baseURL = [[[awareStudy getStudyURL] componentsSeparatedByString:@"?"] firstObject];
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%@/%@/insert", baseURL, sensorName]];
    if (![url.scheme.lowercaseString isEqualToString:@"https"] || !url.host.length) {
        if (callback) callback(@{@"result":@NO, @"name":sensorName, @"error":@"A valid HTTPS study URL is required"});
        return;
    }
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"POST";
    request.timeoutInterval = 90;
    [request setValue:@"application/x-www-form-urlencoded" forHTTPHeaderField:@"Content-Type"];
    NSString *deviceId = [[awareStudy getDeviceId] stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.alphanumericCharacterSet];
    NSMutableData *body = [[NSString stringWithFormat:@"device_id=%@&data=", deviceId] dataUsingEncoding:NSUTF8StringEncoding].mutableCopy;
    [body appendData:batches[index]];
    dataTask = [session uploadTaskWithRequest:request fromData:body completionHandler:^(NSData *reply, NSURLResponse *response, NSError *transportError) {
        // StudyTrace HTTP acknowledgement (a rejected request never advances SQLite).
        NSInteger status = [(NSHTTPURLResponse *)response statusCode];
        dispatch_async(dispatch_get_main_queue(), ^{
            if (transportError || status < 200 || status >= 300) {
                if (callback) callback(@{@"result":@NO, @"name":self->sensorName, @"error":[NSString stringWithFormat:@"Upload failed (HTTP %ld)", (long)status]});
            } else if (index + 1 < batches.count) {
                [self studytraceUploadBatches:batches index:index + 1 callback:callback];
            } else if (callback) {
                callback(@{@"result":@YES, @"name":self->sensorName, @"response":@"acknowledged"});
            }
        });
    }];
    [dataTask resume];
}
