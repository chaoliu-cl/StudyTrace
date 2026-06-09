//
//  AlwaysLocationRequestViewController.swift
//  StudyTrace
//
//  Created by Yuuki Nishiyama on 2020/03/15.
//  Copyright © 2020 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import CoreLocation

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
    }
    
    override func viewDidAppear(_ animated: Bool) {

    }
    
    @IBAction func pushedOpenSettings(_ sender: Any) {
        UIApplication.shared.open(URL(string:  UIApplication.openSettingsURLString)!,options: [:]) { (status) in
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

    func isAuthorizedAlways(with vc: UIViewController) -> Bool {
        guard StudyParticipationController.hasConsent() else {
            return false
        }
        let status = locationManager.authorizationStatus
        if status == .authorizedAlways {
            return true
        } else {
            let storyboard: UIStoryboard = vc.storyboard!
            let alwaysLocationVC = storyboard.instantiateViewController(withIdentifier: "alwaysLocationPermission")
            vc.present(alwaysLocationVC, animated: true, completion: nil)
            return false
        }
    }
}
