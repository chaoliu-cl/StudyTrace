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
            if let times = schedule["times"] as? [String] {
                return !times.isEmpty
            }
            return false
        }
    }
    
    override func viewDidLoad() {
        super.viewDidLoad()
        configureActionButton(title: NSLocalizedString("qr_prompt", value: "Scan your study's QR code", comment: ""), enabled: false)
        
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
        case .denied, .restricted:
            showCameraUnavailableAlert()
        @unknown default:
            showCameraUnavailableAlert()
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
        
        guard let device = videoDevice,
              let videoDeviceInput = try? AVCaptureDeviceInput(device: device),
              captureSession.canAddInput(videoDeviceInput),
              captureSession.canAddOutput(captureMetadataOutput) else {
            captureSession.commitConfiguration()
            showCameraUnavailableAlert()
            return
        }
        captureSession.addInput(videoDeviceInput)
        
        if captureSession.canSetSessionPreset(.hd4K3840x2160){
            captureSession.sessionPreset = .hd4K3840x2160
        }
        
        captureMetadataOutput.setMetadataObjectsDelegate(self, queue: .main)
        captureSession.addOutput(captureMetadataOutput)
        if captureMetadataOutput.availableMetadataObjectTypes.contains(.qr) {
            captureMetadataOutput.metadataObjectTypes = [.qr]
        }
        
        let layer = AVCaptureVideoPreviewLayer(session: captureSession)
        layer.videoGravity = AVLayerVideoGravity.resizeAspectFill
        layer.frame = self.previewView.layer.bounds
        self.previewView.layer.addSublayer(layer)
        previewLayer = layer
        
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
                        #if !DEBUG
                        // Survey schedules come from the study server; importing
                        // them from a QR code is a development tool only.
                        if scannedContent == .json { scannedContent = .unknown }
                        #endif
                        switch scannedContent {
                        case .url:
                            configureActionButton(title: NSLocalizedString("qr_join", value: "Join Study", comment: ""), enabled: true)
                        case .json:
                            configureActionButton(title: "Import ESM Settings", enabled: true)
                        case .unknown:
                            configureActionButton(title: NSLocalizedString("qr_unrecognized", value: "Not a StudyTrace study code", comment: ""), enabled: false)
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
            switch scannedContent {
            case .url:
                guard let secureURL = normalizedSecureStudyURL(QRCodeReaderViewController.normalizedURLCandidate(qr)) else {
                    showInsecureURLAlert()
                    return
                }
                // The consent screen (and any study-switch confirmation) is
                // shown from the screen underneath the scanner.
                let presenter = presentingViewController
                dismiss(animated: true) {
                    if let presenter = presenter {
                        StudyJoinCoordinator.shared.join(studyURL: secureURL, from: presenter)
                    }
                }
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
                                let alert = UIAlertController(title: "Success",
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

    private func showCameraUnavailableAlert() {
        let alert = UIAlertController(
            title: NSLocalizedString("qr_camera_off_title", value: "Camera Not Available", comment: ""),
            message: NSLocalizedString("qr_camera_off_message", value: "StudyTrace needs the camera to scan your study's QR code. You can allow camera access in iOS Settings, or open the study link your research team sent you instead.", comment: ""),
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: NSLocalizedString("qr_open_settings", value: "Open Settings", comment: ""), style: .default) { _ in
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
        })
        alert.addAction(UIAlertAction(title: NSLocalizedString("Close", comment: ""), style: .cancel) { [weak self] _ in
            self?.dismiss(animated: true)
        })
        present(alert, animated: true)
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
