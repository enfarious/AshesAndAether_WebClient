import { App, LoadingScreen } from './app';

const canvas  = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot  = document.getElementById('ui-root') as HTMLElement;
const loading = new LoadingScreen();

const app = new App(canvas, uiRoot, loading);
app.start();
