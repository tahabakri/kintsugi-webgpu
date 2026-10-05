import './styles.css';
import { boot } from './app';

const root = document.querySelector<HTMLElement>('#app');
if (root) void boot(root);
