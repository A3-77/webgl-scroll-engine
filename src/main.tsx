import ReactDOM from 'react-dom/client';
import App from './app/App';
import { installAcceptance } from './dev/acceptance';
import './styles.css';

/**
 * 刻意不用 <React.StrictMode>。
 *
 * StrictMode 在开发模式会把 useEffect 执行两遍（mount → unmount → mount），
 * 而我们的 effect 里要创建 WebGLRenderer + 加载 8 张纹理 + 建 6 个 RenderTarget。
 * 双执行会：
 *   1. 短时间内创建两个 WebGL 上下文（浏览器上下文数量有上限，可能被丢弃）
 *   2. 让异步加载流程和 cleanup 交错，出现"已销毁的上下文里还在上传纹理"的竞态
 * 生产构建下 StrictMode 无副作用，但为了开发体验一致，这里直接不用。
 */
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);

// 里程碑验收的调试入口。内部自己判断 DEV，生产构建里是空操作。
// 用法：地址后加 ?accept=1 自动跑，或在控制台执行 __ACCEPTANCE__.run()
installAcceptance();
