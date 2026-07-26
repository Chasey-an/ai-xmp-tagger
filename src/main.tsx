import { render } from "preact";
import { App } from "./app/App";
import "./styles.css";

const mountNode = document.getElementById("app");

if (!mountNode) {
  throw new Error('Unable to mount app: missing root element "#app".');
}

render(<App />, mountNode);
