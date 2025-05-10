// 请求唤醒锁
let wakeLock = null;

const requestWakeLock = async () => {
  try {
    // 如果已经有激活的唤醒锁，先释放它
    if (wakeLock !== null) {
      await wakeLock.release();
      wakeLock = null;
    }

    // 请求新的唤醒锁
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (err) {
    console.error('请求屏幕唤醒锁失败:', err);
  }
};

// 处理页面可见性变化
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    // 页面变为可见时，请求唤醒锁
    await requestWakeLock();
  } else if (wakeLock !== null) {
    // 页面变为不可见时，释放唤醒锁
    try {
      await wakeLock.release();
      wakeLock = null;
    } catch (err) {
      console.error('释放屏幕唤醒锁失败:', err);
    }
  }
});

// 初始请求唤醒锁（仅当页面 visibleState === 'visible'）
if (document.visibilityState === 'visible') {
  requestWakeLock();
  console.log('请求唤醒锁成功');
}
