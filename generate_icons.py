from PIL import Image
import os

# Ensure the icons directory exists
os.makedirs("icons", exist_ok=True)

# Load the master icon
try:
    img = Image.open("master-icon.png")
    
    # Generate and save the three required Chrome extension sizes
    sizes = [16, 48, 128]
    for size in sizes:
        # LANCZOS ensures high-quality downscaling without aliasing artifacts
        resized_img = img.resize((size, size), Image.Resampling.LANCZOS)
        output_path = f"icons/icon{size}.png"
        resized_img.save(output_path, optimize=True)
        print(f"✅ Saved: {output_path}")
        
    print("\n🎉 Icon generation complete! Ready for manifest.json.")
except FileNotFoundError:
    print("❌ Error: Please ensure 'master-icon.png' is in the project root directory.")