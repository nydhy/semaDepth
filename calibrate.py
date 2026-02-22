import cv2
from engine import calculate_focal_length # We'll add this helper

def run_calibration(image_path, real_width_mm, distance_to_obj_mm):
    img = cv2.imread(image_path)
    # Drag a box around your object (e.g., your laptop) and press ENTER
    roi = cv2.selectROI("Select Object Width", img)
    cv2.destroyAllWindows()
    
    pixel_width = roi[2]
    # f = (P * D) / W
    focal_constant = (pixel_width * distance_to_obj_mm) / real_width_mm
    print(f"\n--- CALIBRATION COMPLETE ---")
    print(f"Your Focal Constant: {focal_constant}")
    print(f"Use this number in your app.py sidebar.")

if __name__ == "__main__":
    # Example: A 320mm laptop at 1000mm (1 meter) distance
    run_calibration('IMG_3411.jpg', 320, 1000)
