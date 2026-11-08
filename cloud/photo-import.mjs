// Bound a full batch to less than the server's 8 MiB request limit.
export async function registrationPhoto(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw Error(`「${file.name}」을 열 수 없습니다. JPG·PNG·WebP 사진을 선택하세요.`); }
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [.85, .7, .55, .4, .25]) {
      const image = canvas.toDataURL('image/jpeg', quality);
      if (image.length <= 100000) return image;
    }
    throw Error(`「${file.name}」의 용량을 줄인 뒤 다시 선택하세요.`);
  } finally { bitmap.close(); }
}
