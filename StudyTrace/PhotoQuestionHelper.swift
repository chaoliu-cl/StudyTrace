import UIKit
import AWAREFramework

final class PhotoQuestionHelper: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {

    static let shared = PhotoQuestionHelper()

    private var completion: ((UIImage?) -> Void)?
    private weak var presenter: UIViewController?

    func presentPhotoPicker(from viewController: UIViewController, completion: @escaping (UIImage?) -> Void) {
        self.presenter = viewController
        self.completion = completion

        let alert = UIAlertController(title: "Add Photo", message: "Choose how to attach a photo to your response.", preferredStyle: .actionSheet)

        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            alert.addAction(UIAlertAction(title: "Take Photo", style: .default) { _ in
                self.showPicker(sourceType: .camera, from: viewController)
            })
        }

        alert.addAction(UIAlertAction(title: "Choose from Library", style: .default) { _ in
            self.showPicker(sourceType: .photoLibrary, from: viewController)
        })

        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
            completion(nil)
        })

        if let popover = alert.popoverPresentationController {
            popover.sourceView = viewController.view
            popover.sourceRect = CGRect(x: viewController.view.bounds.midX, y: viewController.view.bounds.midY, width: 0, height: 0)
        }

        viewController.present(alert, animated: true)
    }

    private func showPicker(sourceType: UIImagePickerController.SourceType, from viewController: UIViewController) {
        let picker = UIImagePickerController()
        picker.sourceType = sourceType
        picker.delegate = self
        picker.allowsEditing = false
        viewController.present(picker, animated: true)
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        let image = info[.originalImage] as? UIImage
        picker.dismiss(animated: true) {
            self.completion?(image)
            self.completion = nil
        }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true) {
            self.completion?(nil)
            self.completion = nil
        }
    }

    static func encodeImageAsBase64(_ image: UIImage, maxDimension: CGFloat = 1024) -> String {
        let resized = resizeImage(image, maxDimension: maxDimension)
        guard let data = resized.jpegData(compressionQuality: 0.8) else { return "" }
        return data.base64EncodedString()
    }

    private static func resizeImage(_ image: UIImage, maxDimension: CGFloat) -> UIImage {
        let size = image.size
        guard size.width > maxDimension || size.height > maxDimension else { return image }

        let scale: CGFloat
        if size.width > size.height {
            scale = maxDimension / size.width
        } else {
            scale = maxDimension / size.height
        }

        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: newSize)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: newSize))
        }
    }
}
