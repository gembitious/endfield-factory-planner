import './style.css';
import { loadCatalog } from './catalog';
import { startApp } from './app';

loadCatalog()
  .then(() => startApp())
  .catch((err) => {
    document.body.innerHTML = `<div style="padding:24px;font-family:sans-serif">
      <h2>설비 데이터를 불러오지 못했습니다</h2>
      <p>${String(err)}</p>
      <p>public/data/facilities.json 파일을 확인해 주세요.</p>
    </div>`;
  });
