"""Export the approved Curated cards SVG to Chrome PNG sizes. Requires ImageMagick."""

from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    destination = Path(__file__).resolve().parents[1] / "extension" / "icons"
    destination.mkdir(exist_ok=True)
    converter = shutil.which("magick") or shutil.which("convert")
    if not converter:
        raise SystemExit("Install ImageMagick to regenerate icons; committed PNGs need no runtime dependency.")
    with tempfile.TemporaryDirectory(prefix="ownfeed-icons-") as folder:
        rendered = Path(folder) / "master.png"
        subprocess.run([converter, "-background", "none", "-density", "768", str(destination / "source.svg"), str(rendered)], check=True)
        for size in (16, 32, 48, 128):
            subprocess.run([converter, str(rendered), "-filter", "Lanczos", "-resize", f"{size}x{size}", "-strip",
                            f"PNG32:{destination / f'icon-{size}.png'}"], check=True)


if __name__ == "__main__":
    main()
