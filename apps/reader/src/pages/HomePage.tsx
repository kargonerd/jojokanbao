import { useNavigate } from "react-router-dom";
import { Card } from "@jojo/ui";

import rmrbImg from "../assets/rmrb.jpeg";
import ckxxImg from "../assets/cankaoxiaoxi.jpeg";
import hqImg from "../assets/hq.jpg";
import rmhbImg from "../assets/rmhb.jpg";
import sjzsImg from "../assets/sjzs.jpg";

const cards = [
  { title: "人民日报", image: rmrbImg, route: "/rmrb/19761009", publisher: "中国共产党中央委员会", year: "1946 —" },
  { title: "参考消息", image: ckxxImg, route: "/ckxx/19760910", publisher: "新华通讯社", year: "1957 —" },
  { title: "红旗", image: hqImg, route: "/hq/196419", publisher: "中国共产党中央委员会", year: "1958 — 1988" },
  { title: "人民画报", image: rmhbImg, route: "/rmhb/197292", publisher: "人民画报社", year: "1950 —" },
  { title: "世界知识", image: sjzsImg, route: "/sjzs/196513", publisher: "世界知识出版社", year: "1934 —" },
];

export function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="max-w-5xl mx-auto px-6 py-8 md:py-10">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {cards.map((card) => (
            <Card key={card.title} className="group cursor-pointer" onClick={() => navigate(card.route)}>
              <div className="overflow-hidden">
                <img src={card.image} alt={card.title} className="w-full block transition-transform duration-500 ease-out group-hover:scale-[1.03]" />
              </div>
              <div className="px-4 py-3.5 border-t border-red/30 bg-paper">
                <h2 className="text-lg font-bold text-red tracking-wider m-0">{card.title}</h2>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-xs text-muted">{card.publisher}</span>
                  <span className="text-xs text-muted tracking-wider">{card.year}</span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
