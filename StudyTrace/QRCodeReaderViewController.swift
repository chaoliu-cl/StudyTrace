//
//  QRCodeReaderViewController.swift
//  StudyTrace
//
//  Created by Yuuki Nishiyama on 2019/02/27.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import AVFoundation
import AWAREFramework

class QRCodeReaderViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {

    @IBOutlet weak var previewView: UIView!
    @IBOutlet weak var closeButton: UIButton!
    @IBOutlet weak var joinButton: UIButton!
    
    var previewLayer:AVCaptureVideoPreviewLayer?
    var qrcodeFrameView:UIView?
    
    private let captureSession = AVCaptureSession()
    private let videoDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .unspecified)
    private let captureMetadataOutput = AVCaptureMetadataOutput()
    
    var qrcodeViewHideTimer = Timer()
    
    var qrcode:String?
    
    var scannedContent:ScannedContent = .unknown
    enum ScannedContent: Equatable {
        case unknown
        case url
        case json
    }

    static func classifyScannedContent(_ rawValue: String) -> ScannedContent {
        if isValidESMScheduleConfig(rawValue) {
            return .json
        }

        guard let url = URL(string: normalizedURLCandidate(rawValue)),
              let scheme = url.scheme?.lowercased() else {
            return .unknown
        }

        switch scheme {
        case "https", "aware", "aware-ssl":
            return .url
        default:
            return .unknown
        }
    }

    static func normalizedURLCandidate(_ rawValue: String) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.contains("://") {
            return trimmed
        }
        // QR generators often omit the scheme. Treat bare host/path study URLs
        // as HTTPS candidates; final join still passes through HTTPS validation.
        if trimmed.contains(".") && !trimmed.contains(" ") {
            return "https://\(trimmed)"
        }
        return trimmed
    }

    static func isValidESMScheduleConfig(_ rawValue: String) -> Bool {
        guard let data = rawValue.data(using: .utf8),
              let jsonObject = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed),
              let jsonArray = jsonObject as? [[String: Any]] else {
            return false
        }

        return jsonArray.contains { schedule in
            guard schedule["schedule_id"] is String else {
                return false
            }
            if let hours = schedule["hours"] as? [Int] {
                return !hours.isEmpty
            }
            if let hours = schedule["hours"] as? [NSNumber] {
                return !hours.isEmpty
            }
            return false
        }
    }
    
    override func viewDidLoad() {
        super.viewDidLoad()
        configureActionButton(title: "Please scan a QR Code", enabled: false)
        
        qrcodeFrameView = UIView(frame: CGRect.zero)
        if let qrcodeFrameView = qrcodeFrameView {
            qrcodeFrameView.layer.borderColor = UIColor.green.cgColor
            qrcodeFrameView.layer.borderWidth = 2
            qrcodeFrameView.layer.cornerRadius = 5
            self.view.addSubview(qrcodeFrameView)
            self.view.bringSubviewToFront(qrcodeFrameView)
        }
    }
    
    override func viewDidAppear(_ animated: Bool) {
        switch AVCaptureDevice.authorizationStatus(for: .video ) {
        case .authorized: // The user has previously granted access to the camera.
            DispatchQueue.main.async {
                self.setupCaptureSession()
            }
        case .notDetermined: // The user has not yet been asked for camera access.
            AVCaptureDevice.requestAccess(for: .video) { granted in
                if granted {
                    DispatchQueue.main.async {
                        self.setupCaptureSession()
                    }
                }
            }
        case .denied: // The user has previously denied access.
            return
        case .restricted: // The user can't grant access due to restrictions.
            return
        }
    }
    
    override func viewDidDisappear(_ animated: Bool) {
        captureSession.stopRunning()
        
        for output in captureSession.outputs {
            //session.removeOutput((output as? AVCaptureOutput)!)
            captureSession.removeOutput(output)
        }
        
        for input in captureSession.inputs {
            //session.removeInput((input as? AVCaptureInput)!)
            captureSession.removeInput(input)
        }
    }
    
    func setupCaptureSession(){
        captureSession.beginConfiguration()
        
        guard
            let videoDeviceInput = try? AVCaptureDeviceInput(device: videoDevice!),
            captureSession.canAddInput(videoDeviceInput)
            else { return }
        captureSession.addInput(videoDeviceInput)
        
        if captureSession.canSetSessionPreset(.hd4K3840x2160){
            captureSession.sessionPreset = .hd4K3840x2160
        }
        
        captureMetadataOutput.setMetadataObjectsDelegate(self, queue: .main)
        captureSession.addOutput(captureMetadataOutput)
        captureMetadataOutput.metadataObjectTypes = [.qr, .face]
        
        previewLayer = AVCaptureVideoPreviewLayer(session: captureSession)
        previewLayer?.videoGravity = AVLayerVideoGravity.resizeAspectFill
        previewLayer?.frame = self.previewView.layer.bounds
         self.previewView.layer.addSublayer(previewLayer!)
        
        captureSession.commitConfiguration()
        
        captureSession.startRunning()
    }
    
    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        for object in metadataObjects {
            switch object.type {
            case .qr:
                if let qrObject = previewLayer?.transformedMetadataObject(for: object) as? AVMetadataMachineReadableCodeObject {
                    qrcodeFrameView?.frame = qrObject.bounds
                    qrcodeFrameView?.isHidden = false
                    qrcodeViewHideTimer.invalidate()
                    qrcodeViewHideTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { (timer) in
                        self.qrcodeFrameView?.isHidden = true
                    }
                    qrcode = qrObject.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
                    
                    
                    /// Checking "URL" or "JSON for ESM"
                    if let str = qrcode {
                        scannedContent = QRCodeReaderViewController.classifyScannedContent(str)
                        switch scannedContent {
                        case .url:
                            configureActionButton(title: "Join Study", enabled: true)
                        case .json:
                            configureActionButton(title: "Import ESM Settings", enabled: true)
                        case .unknown:
                            configureActionButton(title: "Unrecognized QR Code", enabled: false)
                        }
                    }
                }
                break
            default: break
                
            }
            
        }
    }
    
    @IBAction func didPushCloseButton(_ sender: UIButton) {
        self.dismiss(animated: true, completion: nil)
    }
    
    @IBAction func didPushJoinButton(_ sender: UIButton) {
        if let qr = qrcode {
            let study   = AWAREStudy.shared()
            
            switch scannedContent {
            case .url:
                guard let secureURL = normalizedSecureStudyURL(QRCodeReaderViewController.normalizedURLCandidate(qr)) else {
                    showInsecureURLAlert()
                    return
                }
                startIndicator()
                study.join(withURL: secureURL, completion: { (settings, status, error) in
                    DispatchQueue.main.async {
                        
                        switch status {
                        case AwareStudyStateNetworkConnectionError, AwareStudyStateDataFormatError:
                            let alert = UIAlertController(title: "Error", message: "Could not join this study \"\(qr)\" due to a network connection error. Please join this study again.", preferredStyle: .alert)
                            alert.addAction(UIAlertAction.init(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: { (action) in
                                self.dismissIndicator()
                            }))
                            self.present(alert, animated: true) { }
                            return
                        default:
                            break
                        }

                        if StudyParticipationController.hasConsent() {
                            let core = AWARECore.shared()
                            core.requestPermissionForPushNotification { (_, _) in
                                core.requestPermissionForBackgroundSensing { _ in
                                    StudyParticipationController.refreshCollectionState(
                                        fitbitPresenter: self,
                                        createRemoteTables: true
                                    )
                                    self.dismiss(animated: true) {
                                        self.dismissIndicator()
                                    }
                                }
                            }
                        } else {
                            self.dismiss(animated: true) {
                                self.dismissIndicator()
                            }
                        }
                    }
                })
                break
            case .json:
                
                do {
                    if let strData = qr.data(using: .utf8){
                        if let jsonArray = try JSONSerialization.jsonObject(with: strData,
                                                                            options: .fragmentsAllowed) as? [[String:Any]] {
                            let esmManager = ESMScheduleManager.shared()
                            esmManager.removeESMNotifications {
                                
                            }
                            esmManager.removeAllSchedulesFromDB()
                            esmManager.removeAllESMHitoryFromDB()
                            if ESMScheduleManager.shared().setScheduleByConfig(jsonArray) {
                                let alert = UIAlertController(title: "Succees",
                                                              message: "The ESM setting is set correctly!",
                                                              preferredStyle: .alert)
                                alert.addAction(UIAlertAction(title: NSLocalizedString("Close", comment: ""),
                                                              style: .cancel,
                                                              handler: { (action) in
                                    self.dismiss(animated: true) {}
                                    AWAREStudy.shared().setSetting(AWARE_PREFERENCES_STATUS_PLUGIN_IOS_ESM, value: true as NSObject)
                                    StudyParticipationController.refreshCollectionState(
                                        fitbitPresenter: self,
                                        createRemoteTables: !(AWAREStudy.shared().getURL() ?? "").isEmpty
                                    )
                                }))
                                self.present(alert, animated: true) { }
                            }else{
                                let alert = UIAlertController(title: "Error",
                                                              message: "The ESM setting is not set correctly due to unexpected reasons.",
                                                              preferredStyle: .alert)
                                alert.addAction(UIAlertAction(title: NSLocalizedString("Close", comment: ""),
                                                              style: .cancel,
                                                              handler: { (action) in
                                    self.dismiss(animated: true) {}
                                }))
                                self.present(alert, animated: true) { }
                            }
                        }
                    }
                } catch {
                    print(error)
                }
                break
            case .unknown:
                break
            }
        }
    }

    private func configureActionButton(title: String, enabled: Bool) {
        joinButton.layer.borderColor = UIColor.white.cgColor
        joinButton.layer.borderWidth = 2
        joinButton.layer.cornerRadius = 8
        joinButton.backgroundColor = enabled ? UIColor.systemBlue : UIColor.black.withAlphaComponent(0.45)
        joinButton.setTitle(title, for: .normal)
        joinButton.setTitleColor(.white, for: .normal)
        joinButton.isEnabled = enabled
        joinButton.alpha = enabled ? 1.0 : 0.85
    }
}

extension UIViewController {

    func startIndicator() {
        let loadingIndicator = UIActivityIndicatorView(style: .large)
        loadingIndicator.color = .white
        loadingIndicator.center = self.view.center
        let grayOutView = UIView(frame: self.view.frame)
        grayOutView.backgroundColor = .black
        grayOutView.alpha = 0.6

        loadingIndicator.tag = 999
        grayOutView.tag = 999

        self.view.addSubview(grayOutView)
        self.view.addSubview(loadingIndicator)
        self.view.bringSubviewToFront(grayOutView)
        self.view.bringSubviewToFront(loadingIndicator)

        loadingIndicator.startAnimating()
    }

    func dismissIndicator() {
        self.view.subviews.forEach {
            if $0.tag == 999 {
                $0.removeFromSuperview()
            }
        }
    }

}
