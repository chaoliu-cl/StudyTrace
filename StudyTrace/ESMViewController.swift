//
//  ESMViewController.swift
//  StudyTrace
//
//  Created by Yuuki Nishiyama on 2019/02/27.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import AWAREFramework

class ESMViewController: UIViewController {

    @IBOutlet weak var surveyButton: UIButton!

    private let emptyStateStack = UIStackView()
    private let photoButton = UIButton(type: .system)
    private var capturedPhotoData: String?

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Surveys"
        view.backgroundColor = AWARETheme.canvas
        surveyButton.backgroundColor = AWARETheme.accent
        surveyButton.setTitleColor(.white, for: .normal)
        surveyButton.setImage(UIImage(systemName: "doc.text.fill"), for: .normal)
        surveyButton.tintColor = .white
        surveyButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
        surveyButton.titleLabel?.adjustsFontForContentSizeCategory = true
        surveyButton.layer.cornerRadius = 16
        surveyButton.layer.shadowColor = AWARETheme.accent.cgColor
        surveyButton.layer.shadowOpacity = 0.3
        surveyButton.layer.shadowRadius = 12
        surveyButton.layer.shadowOffset = CGSize(width: 0, height: 6)
        surveyButton.imageEdgeInsets = UIEdgeInsets(top: 0, left: -8, bottom: 0, right: 8)
        navigationController?.navigationBar.prefersLargeTitles = true

        setupPhotoButton()
        setupEmptyState()

        if OnboardingManager.isFirstTime() {
            OnboardingManager().startOnboarding(with: self)
        }
    }

    private func setupPhotoButton() {
        photoButton.setTitle(" Attach Photo", for: .normal)
        photoButton.setImage(UIImage(systemName: "camera.fill"), for: .normal)
        photoButton.tintColor = AWARETheme.accent
        photoButton.backgroundColor = AWARETheme.accent.withAlphaComponent(0.1)
        photoButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .subheadline)
        photoButton.layer.cornerRadius = 12
        photoButton.translatesAutoresizingMaskIntoConstraints = false
        photoButton.addTarget(self, action: #selector(didTapPhotoButton), for: .touchUpInside)
        photoButton.isHidden = true
        view.addSubview(photoButton)

        NSLayoutConstraint.activate([
            photoButton.topAnchor.constraint(equalTo: surveyButton.bottomAnchor, constant: 16),
            photoButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            photoButton.widthAnchor.constraint(equalTo: surveyButton.widthAnchor),
            photoButton.heightAnchor.constraint(equalToConstant: 44)
        ])
    }

    @objc private func didTapPhotoButton() {
        AWARETheme.lightImpact()
        PhotoQuestionHelper.shared.presentPhotoPicker(from: self) { [weak self] image in
            guard let self = self, let image = image else { return }
            self.capturedPhotoData = PhotoQuestionHelper.encodeImageAsBase64(image)
            AWAREEventLogger.shared().logEvent([
                "class": "ESMViewController",
                "event": "photo_attached",
                "has_data": "true"
            ])
            self.photoButton.setTitle(" Photo attached", for: .normal)
            self.photoButton.setImage(UIImage(systemName: "checkmark.circle.fill"), for: .normal)
            self.photoButton.tintColor = AWARETheme.success
        }
    }

    private func setupEmptyState() {
        emptyStateStack.axis = .vertical
        emptyStateStack.alignment = .center
        emptyStateStack.spacing = 12
        emptyStateStack.translatesAutoresizingMaskIntoConstraints = false

        let iconView = UIImageView(image: UIImage(systemName: "doc.text.fill"))
        iconView.tintColor = AWARETheme.secondaryInk
        iconView.contentMode = .scaleAspectFit
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.heightAnchor.constraint(equalToConstant: 48).isActive = true
        iconView.widthAnchor.constraint(equalToConstant: 48).isActive = true

        let label = UILabel()
        label.text = "No surveys scheduled"
        label.font = UIFont.preferredFont(forTextStyle: .subheadline)
        label.textColor = AWARETheme.secondaryInk
        label.textAlignment = .center

        emptyStateStack.addArrangedSubview(iconView)
        emptyStateStack.addArrangedSubview(label)
        view.addSubview(emptyStateStack)
        NSLayoutConstraint.activate([
            emptyStateStack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            emptyStateStack.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: 60)
        ])
    }
    
    override func viewDidAppear(_ animated: Bool) {
        self.tabBarController?.tabBar.isHidden = false
        NotificationCenter.default.addObserver(self, selector: #selector(willEnterForegroundNotification(notification:)), name: UIApplication.willEnterForegroundNotification, object: nil)
        self.checkESMSchedules()
        self.hideContextViewIfNeeded()
        if StudyParticipationController.hasConsent() {
            _ = LocationPermissionManager().isAuthorizedAlways(with: self)
        }
    }
    
    override func viewDidDisappear(_ animated: Bool) {
        NotificationCenter.default.removeObserver(self, name: UIApplication.willEnterForegroundNotification, object: nil)
    }
    
    @objc func willEnterForegroundNotification(notification: NSNotification) {
        self.checkESMSchedules()
        if StudyParticipationController.hasConsent() {
            _ = LocationPermissionManager().isAuthorizedAlways(with: self)
        }
    }
    
    func checkESMSchedules(){
        self.tabBarController?.tabBar.isHidden = false
        let esmManager = ESMScheduleManager.shared()
        let schedules = esmManager.getValidSchedules()

        if(schedules.count > 0){
            self.surveyButton.setTitle(" \(schedules.count) survey\(schedules.count == 1 ? "" : "s") available",
                                  for: .normal)
            self.surveyButton.setImage(UIImage(systemName: "doc.text.fill"), for: .normal)
            self.surveyButton.backgroundColor = AWARETheme.accent
            self.surveyButton.layer.borderColor = UIColor.clear.cgColor
            self.surveyButton.layer.borderWidth = 0
            self.surveyButton.isEnabled = true
            self.surveyButton.isHidden = false
            self.photoButton.isHidden = false
            self.emptyStateStack.isHidden = true
            self.tabBarController?.tabBar.items?[2].badgeValue = "\(schedules.count)"
            self.tabBarController?.tabBar.items?[2].badgeColor = AWARETheme.warmAccent
        } else {
            self.surveyButton.isEnabled = false
            self.surveyButton.isHidden = true
            self.photoButton.isHidden = true
            self.emptyStateStack.isHidden = false
            self.tabBarController?.tabBar.items?[2].badgeValue = nil
        }

        capturedPhotoData = nil
        photoButton.setTitle(" Attach Photo", for: .normal)
        photoButton.setImage(UIImage(systemName: "camera.fill"), for: .normal)
        photoButton.tintColor = AWARETheme.accent
        IOSESM.setESMAppearedState(true)
    }
    
    @IBAction func didPushSurveyButton(_ sender: UIButton) {
        let esmManager = ESMScheduleManager.shared()
        let schedules = esmManager.getValidSchedules()
        if( schedules.count > 0){
            self.performSegue(withIdentifier: "toESMScrollView", sender: self)
            self.tabBarController?.tabBar.isHidden = true
        }
    }
    
    // MARK: - Navigation

    // In a storyboard-based application, you will often want to do a little preparation before navigation
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        // Get the new view controller using segue.destination.
        // Pass the selected object to the new view controller.
        
//        if let next = segue.destination as? ESMScrollViewController{
//            next.tabBarController?.tabBar.isHidden = true
//        }
//        self.tabBarController?.tabBar.isHidden = true
        
    }

}

extension UIColor {
    static let system = UIColor.tintColor
}

extension IOSESM {
    
}
