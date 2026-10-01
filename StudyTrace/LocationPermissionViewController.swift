//
//  AlwaysLocationRequestViewController.swift
//  StudyTrace
//
//  Created by Yuuki Nishiyama on 2020/03/15.
//  Copyright © 2020 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import CoreLocation
import AWAREFramework

class LocationPermissionViewController: UIViewController {
    
    @IBOutlet weak var locationOptionImage: UIImageView!
    @IBOutlet weak var permissionListImage: UIImageView!
    @IBOutlet weak var openSettingButton: UIButton!
    
    
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = AWARETheme.canvas
        if Language().isJapanese() {
            locationOptionImage.image = UIImage(named: "location_always_menu_jp")
            permissionListImage.image = UIImage(named: "location_always_option_jp")
        }

        openSettingButton.backgroundColor = AWARETheme.accent
        openSettingButton.setTitleColor(.white, for: .normal)
        openSettingButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
        openSettingButton.layer.cornerRadius = 14
        openSettingButton.isEnabled = true

        let notNow = UIButton(type: .system)
        notNow.setTitle(NSLocalizedString("location_not_now", value: "Not Now", comment: ""), for: .normal)
        notNow.titleLabel?.font = UIFont.preferredFont(forTextStyle: .body)
        notNow.translatesAutoresizingMaskIntoConstraints = false
        notNow.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)
        view.addSubview(notNow)
        NSLayoutConstraint.activate([
            notNow.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            notNow.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20)
        ])
    }
    
    override func viewDidAppear(_ animated: Bool) {

    }
    
    @IBAction func pushedOpenSettings(_ sender: Any) {
        guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(settingsURL, options: [:]) { (status) in
            self.dismiss(animated: true) {
                
            }
        }

    }
    
    /*
    // MARK: - Navigation

    // In a storyboard-based application, you will often want to do a little preparation before navigation
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        // Get the new view controller using segue.destination.
        // Pass the selected object to the new view controller.
    }
    */

}

public class LocationPermissionManager{
    private let locationManager = CLLocationManager()
    private static let explainedKey = "com.studytrace.always-location-explained"

    /// Explains "Always" location once per joined study when it was not
    /// granted. The participant can close it; it is not shown again for that
    /// study, so declining is respected (Guideline 5.1.1(iv)).
    func explainAlwaysIfNeeded(from vc: UIViewController) {
        guard StudyParticipationController.hasConsent(),
              let studyURL = AWAREStudy.shared().getURL(),
              let studyKey = StudyConsentStore.studyKey(for: studyURL),
              locationManager.authorizationStatus != .authorizedAlways,
              locationManager.authorizationStatus != .notDetermined,
              vc.presentedViewController == nil,
              vc.viewIfLoaded?.window != nil else {
            return
        }
        var explained = UserDefaults.standard.stringArray(forKey: Self.explainedKey) ?? []
        guard !explained.contains(studyKey) else { return }
        explained.append(studyKey)
        UserDefaults.standard.set(explained, forKey: Self.explainedKey)
        let storyboard: UIStoryboard = vc.storyboard ?? UIStoryboard(name: "Main", bundle: nil)
        let alwaysLocationVC = storyboard.instantiateViewController(withIdentifier: "alwaysLocationPermission")
        vc.present(alwaysLocationVC, animated: true, completion: nil)
    }
}
