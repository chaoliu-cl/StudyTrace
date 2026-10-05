//
//  SensorTableViewCell.swift
//  StudyTrace
//
//  Created by Yuuki Nishiyama on 2019/02/27.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import AWAREFramework

class StudyTraceTableViewCell: UITableViewCell {

    @IBOutlet weak var icon: UIImageView!
    @IBOutlet weak var title: UILabel!
    @IBOutlet weak var detail: UILabel!
    @IBOutlet weak var progress: UIProgressView!
    @IBOutlet weak var syncStatusIcon: UIImageView!
    
    @IBOutlet weak var iconWidthConstraint: NSLayoutConstraint!
    @IBOutlet weak var iconLeftConstraint: NSLayoutConstraint!
    
    public static let cellName = "StudyTraceTableCell"
    
    var syncStatus:SyncStatus = .unknown
    
    override func awakeFromNib() {
        super.awakeFromNib()
        backgroundColor = .clear
        contentView.backgroundColor = AWARETheme.card
        contentView.layer.cornerRadius = 14
        contentView.layer.masksToBounds = true
        contentView.layer.borderWidth = 0.5
        contentView.layer.borderColor = UIColor.separator.cgColor
        title.font = UIFont.preferredFont(forTextStyle: .headline)
        title.adjustsFontForContentSizeCategory = true
        title.textColor = AWARETheme.ink
        detail.font = UIFont.preferredFont(forTextStyle: .subheadline)
        detail.adjustsFontForContentSizeCategory = true
        detail.textColor = AWARETheme.secondaryInk
        progress.tintColor = AWARETheme.accent
        progress.trackTintColor = AWARETheme.accent.withAlphaComponent(0.14)
    }

    override func setSelected(_ selected: Bool, animated: Bool) {
        super.setSelected(selected, animated: animated)

        // Configure the view for the selected state
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        contentView.frame = contentView.frame.inset(by: UIEdgeInsets(top: 6, left: 14, bottom: 6, right: 14))
    }

    
    func hideIcon(){
        iconWidthConstraint.constant = 0 // 30
        iconLeftConstraint.constant  = 3 // 12
        icon.isHidden = true
    }
    
    func showIcon(){
        iconWidthConstraint.constant = 30
        iconLeftConstraint.constant  = 12
        icon.isHidden = false
    }
    
    func hideSyncProgress(){
        progress.isHidden = true
        syncStatusIcon.isHidden = true
    }
    
    func showSyncProgress(){
        progress.isHidden = false
        syncStatusIcon.isHidden = false
        setSyncStatus(.unknown)
    }
    
    func rotateSyncingIcon(){
        if self.syncStatus == .syncing {
            let timestamp = Int(Date().timeIntervalSince1970 * 100)
            let degree = timestamp%360
            if let icon = syncStatusIcon.image {
                syncStatusIcon.image = icon.rotatedBy(degree: CGFloat(-1 * degree) )
            }
        }
    }
    
    func setSyncStatus(_ status:SyncStatus){
        self.syncStatus = status
        switch status {
        case .done:
            syncStatusIcon.image = UIImage(systemName: "checkmark.circle.fill")
            syncStatusIcon.tintColor = AWARETheme.success
        case .syncing:
            syncStatusIcon.image = UIImage(systemName: "arrow.triangle.2.circlepath")
            syncStatusIcon.tintColor = AWARETheme.accent
            rotateSyncingIcon()
        case .error:
            syncStatusIcon.image = UIImage(systemName: "exclamationmark.triangle.fill")
            syncStatusIcon.tintColor = AWARETheme.destructive
        case .unknown:
            syncStatusIcon.image = nil
        }
    }
}

public enum SyncStatus {
    case done
    case syncing
    case error
    case unknown
}

enum AWARETheme {
    static let canvas = UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.06, green: 0.06, blue: 0.10, alpha: 1.0)
            : UIColor(red: 0.96, green: 0.96, blue: 0.98, alpha: 1.0)
    }
    static let card = UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.12, green: 0.12, blue: 0.18, alpha: 1.0)
            : UIColor.white
    }
    static let ink = UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.94, green: 0.94, blue: 0.98, alpha: 1.0)
            : UIColor(red: 0.10, green: 0.10, blue: 0.16, alpha: 1.0)
    }
    static let secondaryInk = UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.58, green: 0.60, blue: 0.68, alpha: 1.0)
            : UIColor(red: 0.40, green: 0.42, blue: 0.50, alpha: 1.0)
    }
    static let accent = UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.40, green: 0.52, blue: 0.98, alpha: 1.0)
            : UIColor(red: 0.24, green: 0.35, blue: 0.85, alpha: 1.0)
    }
    static let warmAccent = UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.96, green: 0.60, blue: 0.28, alpha: 1.0)
            : UIColor(red: 0.90, green: 0.48, blue: 0.15, alpha: 1.0)
    }
    static let destructive = UIColor.systemRed
    static let success = UIColor.systemGreen

    static func lightImpact() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func mediumImpact() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    static func notificationFeedback(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        UINotificationFeedbackGenerator().notificationOccurred(type)
    }
}

extension UIImage {
    
    func rotatedBy(degree: CGFloat) -> UIImage {
        let radian = -degree * CGFloat.pi / 180
        UIGraphicsBeginImageContext(self.size)
        let context = UIGraphicsGetCurrentContext()!
        context.translateBy(x: self.size.width / 2, y: self.size.height / 2)
        context.scaleBy(x: 1.0, y: -1.0)
        
        context.rotate(by: radian)
        context.draw(self.cgImage!, in: CGRect(x: -(self.size.width / 2), y: -(self.size.height / 2), width: self.size.width, height: self.size.height))
        
        let rotatedImage = UIGraphicsGetImageFromCurrentImageContext()!
        UIGraphicsEndImageContext()
        return rotatedImage
    }
    
}
