import { createRoot } from 'react-dom/client';
import Home from '../pages/_index';
import '../base.css';

const root = document.getElementById('root');
if (!root) throw new Error('Nexus root element was not found');

createRoot(root).render(<Home />);